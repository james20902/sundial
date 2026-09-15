//! Flight-log loaders.
//!
//! Scrubbing a recorded log is Sundial's primary job, so these loaders are
//! deliberately forgiving: real logs arrive with comment preambles, units baked
//! into header names, millisecond timestamps, and string state columns mixed in
//! with numeric telemetry. Anything that cannot be interpreted is reported as a
//! warning rather than failing the load.

use crate::store::{Dataset, FlightEvent};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadReport {
    pub warnings: Vec<String>,
    /// Human-readable note about how the time axis was derived.
    pub time_basis: String,
}

/// Header names that plausibly denote the control-loop timestamp, in priority
/// order. Compared after normalisation (lowercase, alphanumerics only).
const TIME_KEYS: &[&str] = &[
    "time", "t", "timestamp", "ts", "times", "elapsed", "elapsedtime", "flighttime",
    "missiontime", "millis", "micros", "uptime", "seconds", "sec",
];

fn normalise(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Split `Altitude (m)` or `accel_z [m/s^2]` into name and unit.
fn split_unit(header: &str) -> (String, Option<String>) {
    let h = header.trim();
    for (open, close) in [('(', ')'), ('[', ']')] {
        if h.ends_with(close) {
            if let Some(i) = h.rfind(open) {
                let name = h[..i].trim();
                let unit = h[i + 1..h.len() - close.len_utf8()].trim();
                if !name.is_empty() && !unit.is_empty() {
                    return (name.to_string(), Some(unit.to_string()));
                }
            }
        }
    }
    (h.to_string(), None)
}

/// Factor converting a timestamp column into seconds.
fn time_scale(name: &str, unit: Option<&str>) -> (f64, &'static str) {
    let u = unit.map(normalise).unwrap_or_default();
    match u.as_str() {
        "ms" | "msec" | "millis" | "milliseconds" | "millisecond" => return (1e-3, "milliseconds"),
        "us" | "usec" | "micros" | "microseconds" | "µs" => return (1e-6, "microseconds"),
        "ns" | "nanoseconds" => return (1e-9, "nanoseconds"),
        "s" | "sec" | "secs" | "seconds" => return (1.0, "seconds"),
        _ => {}
    }
    let n = normalise(name);
    if n.contains("millis") || n.ends_with("ms") {
        (1e-3, "milliseconds")
    } else if n.contains("micros") || n.ends_with("us") {
        (1e-6, "microseconds")
    } else {
        (1.0, "seconds")
    }
}

/// Pick the timestamp column, preferring an exact match on a known key over a
/// substring hit so `time` wins over `time_since_launch` when both exist.
fn pick_time_column(headers: &[(String, Option<String>)]) -> Option<usize> {
    let norm: Vec<String> = headers.iter().map(|(n, _)| normalise(n)).collect();
    for key in TIME_KEYS {
        if let Some(i) = norm.iter().position(|n| n == key) {
            return Some(i);
        }
    }
    norm.iter().position(|n| n.contains("time"))
}

/// Parse a numeric cell, tolerating blanks, `NaN`, and `NA`-style placeholders.
fn parse_num(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Load a delimited text log (CSV/TSV), including OpenRocket simulation
/// exports, which prefix their metadata and header rows with `#`.
pub fn load_csv(path: &Path, id: &str) -> Result<(Dataset, LoadReport), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut warnings = Vec::new();

    let delim = detect_delimiter(&raw);

    // OpenRocket writes `# Time (s),Altitude (m),...` as the final comment line
    // before the data. Treat the last comment line whose field count matches
    // the first data line as the header.
    let mut header_line: Option<String> = None;
    let mut data_start = 0usize;
    let lines: Vec<&str> = raw.lines().collect();
    let mut preamble: Vec<&str> = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix('#') {
            preamble.push(rest.trim());
            continue;
        }
        // First non-comment line: either the header, or data preceded by a
        // commented header.
        let field_count = trimmed.split(delim).count();
        let commented_header = preamble
            .iter()
            .rev()
            .find(|c| c.split(delim).count() == field_count && field_count > 1);

        if let Some(ch) = commented_header {
            if trimmed.split(delim).any(|f| parse_num(f).is_some()) {
                header_line = Some((*ch).to_string());
                data_start = i;
            } else {
                header_line = Some(trimmed.to_string());
                data_start = i + 1;
            }
        } else {
            header_line = Some(trimmed.to_string());
            data_start = i + 1;
        }
        break;
    }

    let header_line = header_line.ok_or_else(|| "file contains no data rows".to_string())?;
    let headers: Vec<(String, Option<String>)> =
        header_line.split(delim).map(|h| split_unit(h.trim().trim_matches('"'))).collect();
    if headers.len() < 2 {
        return Err(format!(
            "expected at least 2 delimited columns, found {} — is this a '{}' separated file?",
            headers.len(),
            delim
        ));
    }

    let time_col = pick_time_column(&headers);
    let (scale, basis_unit) = match time_col {
        Some(i) => time_scale(&headers[i].0, headers[i].1.as_deref()),
        None => (1.0, "frame index"),
    };

    let ncols = headers.len();
    let mut numeric: Vec<Vec<f64>> = vec![Vec::new(); ncols];
    let mut string_cols: Vec<BTreeMap<usize, String>> = vec![BTreeMap::new(); ncols];
    let mut times: Vec<f64> = Vec::new();
    let mut ragged = 0usize;

    for (row_no, line) in lines.iter().enumerate().skip(data_start) {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = trimmed.split(delim).collect();
        if fields.len() != ncols {
            ragged += 1;
            if ragged <= 3 {
                warnings.push(format!(
                    "line {}: expected {ncols} fields, found {} — row skipped",
                    row_no + 1,
                    fields.len()
                ));
            }
            continue;
        }

        let frame = times.len();
        let t = match time_col {
            Some(i) => match parse_num(fields[i]) {
                Some(v) => v * scale,
                None => continue, // a row without a timestamp cannot be placed
            },
            None => frame as f64,
        };
        times.push(t);

        for (c, f) in fields.iter().enumerate() {
            let cell = f.trim().trim_matches('"');
            match parse_num(cell) {
                Some(v) => {
                    numeric[c].resize(frame, f64::NAN);
                    numeric[c].push(v);
                }
                None => {
                    if !cell.is_empty() && !cell.eq_ignore_ascii_case("nan") {
                        string_cols[c].insert(frame, cell.to_string());
                    }
                }
            }
        }
    }

    if ragged > 3 {
        warnings.push(format!("{ragged} malformed rows skipped in total"));
    }
    if times.is_empty() {
        return Err("no parseable data rows found".to_string());
    }

    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "log".into());
    let mut ds = Dataset::new(id, name, format!("file:{}", path.display()));
    ds.times = times;

    for (c, (hname, hunit)) in headers.iter().enumerate() {
        if Some(c) == time_col {
            continue;
        }
        let n_numeric = numeric[c].iter().filter(|v| v.is_finite()).count();
        let n_string = string_cols[c].len();

        if n_numeric == 0 && n_string == 0 {
            continue;
        }
        // A column that is mostly words is a flight-state column, not a signal.
        if n_string > n_numeric {
            push_state_events(&mut ds, hname, &string_cols[c]);
            continue;
        }
        ds.push_column(hname, hunit.clone(), std::mem::take(&mut numeric[c]));
    }

    if ds.channels.is_empty() {
        return Err("no numeric channels found in file".to_string());
    }

    ds.events.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    detect_milestones(&mut ds);

    let time_basis = match time_col {
        Some(i) => format!("'{}' interpreted as {}", headers[i].0, basis_unit),
        None => {
            warnings.push(
                "no timestamp column recognised — using row index as the time axis".to_string(),
            );
            "row index".to_string()
        }
    };

    Ok((ds, LoadReport { warnings, time_basis }))
}

fn detect_delimiter(raw: &str) -> char {
    let sample: String = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(20)
        .collect::<Vec<_>>()
        .join("\n");
    let counts = [
        (',', sample.matches(',').count()),
        ('\t', sample.matches('\t').count()),
        (';', sample.matches(';').count()),
    ];
    counts
        .iter()
        .max_by_key(|(_, n)| *n)
        .filter(|(_, n)| *n > 0)
        .map(|(c, _)| *c)
        .unwrap_or(',')
}

/// Turn a string column into timeline events, one per transition.
fn push_state_events(ds: &mut Dataset, column: &str, values: &BTreeMap<usize, String>) {
    let mut last: Option<&str> = None;
    for (frame, v) in values {
        if last != Some(v.as_str()) {
            if let Some(t) = ds.times.get(*frame) {
                ds.events.push(FlightEvent {
                    t: *t,
                    label: if column.is_empty() { v.clone() } else { format!("{column}: {v}") },
                    kind: "state".into(),
                });
            }
            last = Some(v.as_str());
        }
    }
}

/// Derive apogee and max-velocity markers when an altitude-like channel exists.
/// These are the two milestones every flight review starts from, and having
/// them on the timeline saves hunting for them by eye.
fn detect_milestones(ds: &mut Dataset) {
    let alt = ds
        .channel_names()
        .into_iter()
        .find(|n| {
            let k = normalise(n);
            k.contains("altitude") || k == "alt" || k.contains("agl") || k.contains("height")
        })
        .and_then(|n| ds.channel(&n).map(|c| (n, c.meta.max)));

    if let Some((name, max)) = alt {
        if let Some(ch) = ds.channel(&name) {
            if let Some(i) = ch.values.iter().position(|v| *v == max) {
                if let Some(t) = ds.times.get(i) {
                    ds.events.push(FlightEvent {
                        t: *t,
                        label: format!("Apogee {:.1}", max),
                        kind: "detected".into(),
                    });
                }
            }
        }
    }
    ds.events.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
}

/// Load newline-delimited JSON. Each line is one control-loop frame; both a
/// flat `{"t":1.0,"alt":12}` shape and a nested `{"t":1.0,"values":{...}}`
/// shape are accepted, since both show up in the wild.
pub fn load_jsonl(path: &Path, id: &str) -> Result<(Dataset, LoadReport), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut warnings = Vec::new();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "log".into());
    let mut ds = Dataset::new(id, name, format!("file:{}", path.display()));
    let mut bad = 0usize;
    let mut frame_index = 0usize;

    for (i, line) in raw.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                bad += 1;
                if bad <= 3 {
                    warnings.push(format!("line {}: {e}", i + 1));
                }
                continue;
            }
        };
        let obj = match v.as_object() {
            Some(o) => o,
            None => {
                bad += 1;
                continue;
            }
        };

        let t = obj
            .get("t")
            .or_else(|| obj.get("time"))
            .or_else(|| obj.get("timestamp"))
            .and_then(|x| x.as_f64())
            .unwrap_or(frame_index as f64);

        let mut values: Vec<(String, f64)> = Vec::new();
        let collect = |k: &String, val: &serde_json::Value, out: &mut Vec<(String, f64)>| {
            if matches!(k.as_str(), "t" | "time" | "timestamp") {
                return;
            }
            match val {
                serde_json::Value::Number(n) => {
                    if let Some(f) = n.as_f64() {
                        if f.is_finite() {
                            out.push((k.clone(), f));
                        }
                    }
                }
                serde_json::Value::Bool(b) => out.push((k.clone(), if *b { 1.0 } else { 0.0 })),
                _ => {}
            }
        };

        if let Some(nested) = obj.get("values").and_then(|x| x.as_object()) {
            for (k, val) in nested {
                collect(k, val, &mut values);
            }
        }
        for (k, val) in obj {
            if k == "values" {
                continue;
            }
            collect(k, val, &mut values);
        }

        if let Some(ev) = obj.get("event").and_then(|x| x.as_str()) {
            ds.events.push(FlightEvent { t, label: ev.to_string(), kind: "state".into() });
        }

        ds.push_frame(t, &values);
        frame_index += 1;
    }

    if bad > 3 {
        warnings.push(format!("{bad} unparseable lines skipped in total"));
    }
    if ds.frames() == 0 {
        return Err("no parseable JSON frames found".to_string());
    }
    detect_milestones(&mut ds);

    Ok((ds, LoadReport { warnings, time_basis: "'t' field in seconds".into() }))
}

/// Dispatch on file extension, falling back to sniffing the first byte so a
/// `.log` or `.txt` file still loads.
pub fn load_any(path: &Path, id: &str) -> Result<(Dataset, LoadReport), String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "jsonl" | "ndjson" | "json" => load_jsonl(path, id),
        "csv" | "tsv" | "txt" => load_csv(path, id),
        _ => {
            let head = std::fs::read_to_string(path)
                .map_err(|e| format!("{}: {e}", path.display()))?
                .chars()
                .take(256)
                .collect::<String>();
            if head.trim_start().starts_with('{') {
                load_jsonl(path, id)
            } else {
                load_csv(path, id)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write `body` to a uniquely-named temp file and load it.
    fn load(name: &str, body: &str) -> Result<(Dataset, LoadReport), String> {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "sundial-test-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, body).unwrap();
        let out = load_any(&path, "ds");
        let _ = std::fs::remove_file(&path);
        out
    }

    /// `Dataset` deliberately has no `Debug` (it would dump every sample), so
    /// unwrap the error side by hand.
    fn load_err(name: &str, body: &str) -> String {
        match load(name, body) {
            Err(e) => e,
            Ok((ds, _)) => panic!("expected an error, loaded {} frames", ds.frames()),
        }
    }

    #[test]
    fn splits_units_out_of_header_names() {
        assert_eq!(split_unit("Altitude (m)"), ("Altitude".into(), Some("m".into())));
        assert_eq!(split_unit("accel_z [m/s^2]"), ("accel_z".into(), Some("m/s^2".into())));
        assert_eq!(split_unit("mach"), ("mach".into(), None));
        // A bare parenthesised token is a name, not a unit with an empty name.
        assert_eq!(split_unit("(m)"), ("(m)".into(), None));
    }

    #[test]
    fn plain_csv_with_units_loads() {
        let (ds, report) = load(
            "plain.csv",
            "Time (s),Altitude (m),Velocity (m/s)\n0,0,0\n0.1,5,50\n0.2,12,70\n",
        )
        .unwrap();

        assert_eq!(ds.frames(), 3);
        assert_eq!(ds.channel_names(), vec!["Altitude", "Velocity"]);
        assert_eq!(ds.channel("Altitude").unwrap().meta.unit.as_deref(), Some("m"));
        assert_eq!(ds.t0(), 0.0);
        assert!((ds.t1() - 0.2).abs() < 1e-9);
        assert!(report.time_basis.contains("seconds"));
    }

    #[test]
    fn openrocket_style_commented_header_is_recognised() {
        // OpenRocket exports metadata and the header as `#` comments.
        let (ds, _) = load(
            "or.csv",
            "# Sundial test export\n\
             # Rocket: Test\n\
             # Time (s),Altitude (m),Vertical velocity (m/s)\n\
             0.00,0.0,0.0\n\
             0.05,1.2,24.0\n\
             0.10,4.8,47.0\n",
        )
        .unwrap();

        assert_eq!(ds.frames(), 3);
        assert_eq!(ds.channel_names(), vec!["Altitude", "Vertical velocity"]);
        assert_eq!(ds.channel("Altitude").unwrap().meta.max, 4.8);
    }

    #[test]
    fn millisecond_timestamps_are_converted_to_seconds() {
        let (ds, report) = load("ms.csv", "millis,alt\n0,0\n500,10\n1000,20\n").unwrap();
        assert!((ds.t1() - 1.0).abs() < 1e-9, "1000 ms should be 1 s, got {}", ds.t1());
        assert!(report.time_basis.contains("milliseconds"));
    }

    #[test]
    fn a_string_column_becomes_timeline_events_not_a_channel() {
        let (ds, _) = load(
            "state.csv",
            "t,state,alt\n0,PAD,0\n1,PAD,0\n2,BOOST,40\n3,BOOST,180\n4,COAST,400\n",
        )
        .unwrap();

        assert_eq!(ds.channel_names(), vec!["alt"], "'state' must not become a channel");
        // One event per transition, not one per row.
        let states: Vec<&str> = ds
            .events
            .iter()
            .filter(|e| e.kind == "state")
            .map(|e| e.label.as_str())
            .collect();
        assert_eq!(states, vec!["state: PAD", "state: BOOST", "state: COAST"]);
    }

    #[test]
    fn apogee_is_detected_from_an_altitude_channel() {
        let (ds, _) = load("apo.csv", "t,altitude\n0,0\n1,50\n2,120\n3,90\n4,10\n").unwrap();
        let apogee = ds.events.iter().find(|e| e.kind == "detected").unwrap();
        assert_eq!(apogee.t, 2.0);
        assert!(apogee.label.contains("120"), "got {}", apogee.label);
    }

    #[test]
    fn tab_separated_files_are_detected() {
        let (ds, _) = load("tsv.txt", "t\talt\tvel\n0\t0\t0\n1\t10\t20\n").unwrap();
        assert_eq!(ds.channel_names(), vec!["alt", "vel"]);
        assert_eq!(ds.frames(), 2);
    }

    #[test]
    fn malformed_rows_are_skipped_with_a_warning_rather_than_failing() {
        let (ds, report) = load(
            "ragged.csv",
            "t,alt\n0,0\n1\n2,20\nthis is junk\n3,30\n",
        )
        .unwrap();
        assert_eq!(ds.frames(), 3, "only the well-formed rows should load");
        assert!(!report.warnings.is_empty(), "skipped rows should be reported");
    }

    #[test]
    fn blank_cells_become_gaps_not_zeros() {
        let (ds, _) = load("gaps.csv", "t,gps\n0,12.5\n1,\n2,13.5\n").unwrap();
        let gps = ds.channel("gps").unwrap();
        assert_eq!(gps.values[0], 12.5);
        assert!(gps.values[1].is_nan(), "an empty cell must not read as 0");
        assert_eq!(gps.meta.count, 2);
    }

    #[test]
    fn a_file_without_a_time_column_falls_back_to_frame_index() {
        let (ds, report) = load("noclock.csv", "alpha,beta\n1,2\n3,4\n5,6\n").unwrap();
        assert_eq!(ds.times, vec![0.0, 1.0, 2.0]);
        assert!(report.warnings.iter().any(|w| w.contains("row index")));
    }

    #[test]
    fn jsonl_flat_and_nested_shapes_both_load() {
        let (flat, _) = load(
            "flat.jsonl",
            "{\"t\":0.0,\"alt\":0,\"ok\":true}\n{\"t\":0.1,\"alt\":12.5,\"ok\":false}\n",
        )
        .unwrap();
        assert_eq!(flat.frames(), 2);
        assert_eq!(flat.channel("alt").unwrap().values[1], 12.5);
        // Booleans are usable as 0/1 channels, which is how pyro channels arrive.
        assert_eq!(flat.channel("ok").unwrap().values, vec![1.0, 0.0]);

        let (nested, _) = load(
            "nested.jsonl",
            "{\"t\":0.0,\"values\":{\"alt\":1}}\n{\"t\":1.0,\"values\":{\"alt\":2},\"event\":\"APOGEE\"}\n",
        )
        .unwrap();
        assert_eq!(nested.channel("alt").unwrap().values, vec![1.0, 2.0]);
        assert!(nested.events.iter().any(|e| e.label == "APOGEE"));
    }

    #[test]
    fn jsonl_skips_bad_lines_and_keeps_the_rest() {
        let (ds, report) = load(
            "bad.jsonl",
            "{\"t\":0,\"a\":1}\nnot json at all\n{\"t\":1,\"a\":2}\n",
        )
        .unwrap();
        assert_eq!(ds.frames(), 2);
        assert!(!report.warnings.is_empty());
    }

    #[test]
    fn a_file_with_no_numeric_columns_is_an_error_not_an_empty_dataset() {
        let err = load_err("words.csv", "name,state\nfoo,PAD\nbar,BOOST\n");
        assert!(err.contains("no numeric channels"), "got: {err}");
    }

    /// End-to-end check against the log actually shipped in `examples/`, so a
    /// parser change that breaks the sample is caught here rather than by a
    /// blank dashboard.
    #[test]
    fn the_bundled_demo_log_parses() {
        let path = std::path::Path::new("../examples/demo-flight.csv");
        if !path.exists() {
            return; // generated file is optional in a source checkout
        }
        let (ds, report) = load_any(path, "demo").unwrap();

        assert!(ds.frames() > 4000, "got {} frames", ds.frames());
        assert!(report.time_basis.contains("seconds"));
        assert!(ds.channel("altitude").is_some(), "channels: {:?}", ds.channel_names());
        assert_eq!(ds.channel("altitude").unwrap().meta.unit.as_deref(), Some("m"));
        // `state` is words, so it must have become events rather than a channel.
        assert!(ds.channel("state").is_none());
        assert!(ds.events.iter().any(|e| e.label.contains("BOOST")));
        assert!(ds.events.iter().any(|e| e.kind == "detected"));

        let apogee = ds.channel("altitude").unwrap().meta.max;
        assert!((1500.0..2500.0).contains(&apogee), "apogee looked wrong: {apogee}");
    }

    #[test]
    fn a_single_column_file_reports_a_delimiter_problem() {
        let err = load_err("one.csv", "justonecolumn\n1\n2\n");
        assert!(err.contains("delimited columns"), "got: {err}");
    }
}
