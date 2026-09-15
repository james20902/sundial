//! Tools the model can call against the loaded flight log.
//!
//! The chat panel is only interesting if the model can interrogate the actual
//! samples rather than a summary someone pasted in, so every tool here reads
//! the live [`Dataset`]. Results are formatted compactly — a flight log has
//! far more points than any context window wants, so the tools return
//! decimated series and aggregates, and the model is told the decimation
//! factor so it does not mistake a downsampled trace for raw data.

use crate::store::Dataset;
use serde_json::{json, Value};

pub struct ToolOutcome {
    pub content: String,
    pub is_error: bool,
    /// One-line description shown in the chat transcript's tool trace.
    pub summary: String,
}

impl ToolOutcome {
    fn ok(summary: impl Into<String>, content: impl Into<String>) -> Self {
        ToolOutcome { content: content.into(), is_error: false, summary: summary.into() }
    }
    fn err(msg: impl Into<String>) -> Self {
        let m = msg.into();
        ToolOutcome { summary: format!("error: {m}"), content: m, is_error: true }
    }
}

/// JSON Schema definitions shared by every provider. The Anthropic and
/// OpenAI-compatible wire formats wrap these differently but the schema itself
/// is identical, so it is declared once here.
pub fn specs() -> Vec<Value> {
    vec![
        json!({
            "name": "list_channels",
            "description": "List every telemetry channel in the loaded flight log with its unit, \
                            full-flight min/max, and sample count. Call this first to discover what \
                            data exists before querying it.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "string",
                        "description": "Optional case-insensitive substring to match channel names against."
                    }
                }
            }
        }),
        json!({
            "name": "channel_stats",
            "description": "Aggregate statistics (count, min, max, mean, stddev, first, last, and the \
                            times at which min and max occurred) for one or more channels over a time \
                            range. Prefer this over query_series when you want numbers rather than a shape.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "channels": {
                        "type": "array", "items": {"type": "string"},
                        "description": "Channel names, exactly as returned by list_channels."
                    },
                    "t0": {"type": "number", "description": "Start time in seconds. Omit for the start of the log."},
                    "t1": {"type": "number", "description": "End time in seconds. Omit for the end of the log."}
                },
                "required": ["channels"]
            }
        }),
        json!({
            "name": "query_series",
            "description": "Fetch the sample values of one or more channels over a time range. The result \
                            is min/max decimated to at most max_points per channel, which preserves spikes \
                            but is not raw data — the response states the decimation factor.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "channels": {"type": "array", "items": {"type": "string"}},
                    "t0": {"type": "number"},
                    "t1": {"type": "number"},
                    "max_points": {
                        "type": "integer",
                        "description": "Points per channel, 10-400. Defaults to 120."
                    }
                },
                "required": ["channels"]
            }
        }),
        json!({
            "name": "sample_at",
            "description": "Read the value of every requested channel at one instant, as the readout \
                            widgets would show it at that cursor position.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "t": {"type": "number", "description": "Time in seconds."},
                    "channels": {
                        "type": "array", "items": {"type": "string"},
                        "description": "Omit to sample every channel."
                    }
                },
                "required": ["t"]
            }
        }),
        json!({
            "name": "find_crossings",
            "description": "Find the times at which a channel crosses a threshold. Useful for locating \
                            burnout, deployment, or any state change that shows up as a level crossing.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "channel": {"type": "string"},
                    "value": {"type": "number", "description": "Threshold to cross."},
                    "direction": {
                        "type": "string", "enum": ["rising", "falling", "both"],
                        "description": "Defaults to both."
                    },
                    "t0": {"type": "number"},
                    "t1": {"type": "number"},
                    "limit": {"type": "integer", "description": "Max crossings to return, default 20."}
                },
                "required": ["channel", "value"]
            }
        }),
        json!({
            "name": "list_events",
            "description": "List the flight events on the timeline — state transitions parsed from the \
                            log, detected milestones such as apogee, and operator markers.",
            "input_schema": {"type": "object", "properties": {}}
        }),
    ]
}

fn range(ds: &Dataset, input: &Value) -> (f64, f64) {
    let t0 = input.get("t0").and_then(|v| v.as_f64()).unwrap_or(ds.t0());
    let t1 = input.get("t1").and_then(|v| v.as_f64()).unwrap_or(ds.t1());
    if t1 < t0 {
        (t1, t0)
    } else {
        (t0, t1)
    }
}

fn names(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// Format a float without trailing noise: telemetry rarely needs more than
/// four significant decimals and shorter numbers mean more room for analysis.
fn num(v: f64) -> String {
    if v == 0.0 {
        "0".into()
    } else if v.abs() >= 1e6 || v.abs() < 1e-4 {
        format!("{v:.4e}")
    } else {
        let s = format!("{v:.4}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

pub fn execute(ds: Option<&Dataset>, name: &str, input: &Value) -> ToolOutcome {
    let Some(ds) = ds else {
        return ToolOutcome::err(
            "No flight log is loaded. Ask the operator to open a log from the source bar.",
        );
    };

    match name {
        "list_channels" => {
            let filter = input.get("filter").and_then(|v| v.as_str()).map(str::to_lowercase);
            let mut lines = vec![format!(
                "Dataset '{}' — {} frames, t = {} .. {} s",
                ds.name,
                ds.frames(),
                num(ds.t0()),
                num(ds.t1())
            )];
            let mut shown = 0;
            for ch in &ds.channels {
                let m = ch.meta_normalised();
                if let Some(f) = &filter {
                    if !m.name.to_lowercase().contains(f.as_str()) {
                        continue;
                    }
                }
                shown += 1;
                lines.push(format!(
                    "{}{} | range {} .. {} | {} samples",
                    m.name,
                    m.unit.map(|u| format!(" ({u})")).unwrap_or_default(),
                    num(m.min),
                    num(m.max),
                    m.count
                ));
            }
            if shown == 0 {
                lines.push("(no channels matched)".into());
            }
            ToolOutcome::ok(format!("listed {shown} channels"), lines.join("\n"))
        }

        "channel_stats" => {
            let chans = names(input, "channels");
            if chans.is_empty() {
                return ToolOutcome::err("'channels' must contain at least one channel name");
            }
            let (t0, t1) = range(ds, input);
            let stats = ds.stats(&chans, t0, t1);
            if stats.is_empty() {
                return ToolOutcome::err(format!("no such channels: {}", chans.join(", ")));
            }
            let mut lines = vec![format!("Window {} .. {} s", num(t0), num(t1))];
            for s in stats {
                match (s.min, s.max, s.mean, s.stddev) {
                    (Some(mn), Some(mx), Some(mean), Some(sd)) => lines.push(format!(
                        "{}{}: n={} min={} (t={}) max={} (t={}) mean={} sd={} first={} last={}",
                        s.name,
                        s.unit.map(|u| format!(" [{u}]")).unwrap_or_default(),
                        s.count,
                        num(mn),
                        num(s.t_min.unwrap_or(0.0)),
                        num(mx),
                        num(s.t_max.unwrap_or(0.0)),
                        num(mean),
                        num(sd),
                        s.first.map(num).unwrap_or_else(|| "-".into()),
                        s.last.map(num).unwrap_or_else(|| "-".into()),
                    )),
                    _ => lines.push(format!("{}: no samples in window", s.name)),
                }
            }
            ToolOutcome::ok(format!("stats for {} channel(s)", chans.len()), lines.join("\n"))
        }

        "query_series" => {
            let chans = names(input, "channels");
            if chans.is_empty() {
                return ToolOutcome::err("'channels' must contain at least one channel name");
            }
            let (t0, t1) = range(ds, input);
            let max_points = input
                .get("max_points")
                .and_then(|v| v.as_u64())
                .unwrap_or(120)
                .clamp(10, 400) as usize;
            let q = ds.query(&chans, t0, t1, max_points);
            if q.series.is_empty() {
                return ToolOutcome::err(format!("no such channels: {}", chans.join(", ")));
            }

            let mut lines = Vec::new();
            lines.push(format!(
                "Window {} .. {} s covering {} frames{}",
                num(t0),
                num(t1),
                q.source_frames,
                if q.decimated {
                    format!(
                        ", min/max decimated to {} points per channel (~{}x)",
                        q.times.len(),
                        (q.source_frames / q.times.len().max(1)).max(1)
                    )
                } else {
                    ", raw samples".into()
                }
            ));
            lines.push(format!(
                "t: [{}]",
                q.times.iter().map(|t| num(*t)).collect::<Vec<_>>().join(", ")
            ));
            for s in &q.series {
                lines.push(format!(
                    "{}{}: [{}]",
                    s.name,
                    s.unit.clone().map(|u| format!(" [{u}]")).unwrap_or_default(),
                    s.values
                        .iter()
                        .map(|v| v.map(num).unwrap_or_else(|| "null".into()))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            ToolOutcome::ok(
                format!("{} pts x {} channel(s)", q.times.len(), q.series.len()),
                lines.join("\n"),
            )
        }

        "sample_at" => {
            let Some(t) = input.get("t").and_then(|v| v.as_f64()) else {
                return ToolOutcome::err("'t' is required");
            };
            let chans = {
                let c = names(input, "channels");
                if c.is_empty() {
                    ds.channel_names()
                } else {
                    c
                }
            };
            let vals = ds.sample_at(t, &chans, f64::INFINITY);
            let idx = ds.index_at(t);
            let actual = ds.times.get(idx).copied().unwrap_or(t);
            let body = chans
                .iter()
                .zip(vals)
                .map(|(n, v)| format!("{n} = {}", v.map(num).unwrap_or_else(|| "—".into())))
                .collect::<Vec<_>>()
                .join("\n");
            ToolOutcome::ok(
                format!("sampled at t={}", num(actual)),
                format!("Frame {idx} at t={} s (nearest to {}):\n{body}", num(actual), num(t)),
            )
        }

        "find_crossings" => {
            let Some(chan) = input.get("channel").and_then(|v| v.as_str()) else {
                return ToolOutcome::err("'channel' is required");
            };
            let Some(threshold) = input.get("value").and_then(|v| v.as_f64()) else {
                return ToolOutcome::err("'value' is required");
            };
            let dir = input.get("direction").and_then(|v| v.as_str()).unwrap_or("both");
            let limit =
                input.get("limit").and_then(|v| v.as_u64()).unwrap_or(20).clamp(1, 200) as usize;
            let (t0, t1) = range(ds, input);
            let Some(ch) = ds.channel(chan) else {
                return ToolOutcome::err(format!("no channel named '{chan}'"));
            };

            let mut hits = Vec::new();
            let mut prev: Option<(f64, f64)> = None; // (t, value)
            for (i, v) in ch.values.iter().enumerate() {
                let t = ds.times[i];
                if t < t0 || t > t1 || !v.is_finite() {
                    continue;
                }
                if let Some((pt, pv)) = prev {
                    let rising = pv < threshold && *v >= threshold;
                    let falling = pv > threshold && *v <= threshold;
                    let want = match dir {
                        "rising" => rising,
                        "falling" => falling,
                        _ => rising || falling,
                    };
                    if want {
                        // Linear interpolation between the bracketing samples
                        // gives a time that does not depend on the loop rate.
                        let frac =
                            if (v - pv).abs() > f64::EPSILON { (threshold - pv) / (v - pv) } else { 0.0 };
                        let tc = pt + (t - pt) * frac;
                        hits.push(format!(
                            "{} at t={} s",
                            if rising { "rising" } else { "falling" },
                            num(tc)
                        ));
                        if hits.len() >= limit {
                            break;
                        }
                    }
                }
                prev = Some((t, *v));
            }

            if hits.is_empty() {
                ToolOutcome::ok(
                    "no crossings",
                    format!(
                        "'{chan}' never crosses {} in {} .. {} s (channel range {} .. {}).",
                        num(threshold),
                        num(t0),
                        num(t1),
                        num(ch.meta_normalised().min),
                        num(ch.meta_normalised().max)
                    ),
                )
            } else {
                ToolOutcome::ok(
                    format!("{} crossing(s)", hits.len()),
                    format!("'{chan}' crossing {}:\n{}", num(threshold), hits.join("\n")),
                )
            }
        }

        "list_events" => {
            if ds.events.is_empty() {
                return ToolOutcome::ok(
                    "no events",
                    "This log has no timeline events.",
                );
            }
            let body = ds
                .events
                .iter()
                .map(|e| format!("t={} s [{}] {}", num(e.t), e.kind, e.label))
                .collect::<Vec<_>>()
                .join("\n");
            ToolOutcome::ok(format!("{} event(s)", ds.events.len()), body)
        }

        other => ToolOutcome::err(format!("unknown tool '{other}'")),
    }
}
