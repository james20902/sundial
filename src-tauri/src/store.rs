//! Columnar telemetry store.
//!
//! The controller's data model is one timestamp per control-loop iteration with
//! a bundle of datapoints tagged to it. That maps naturally onto a columnar
//! layout: a single `times` vector shared by every channel, and one parallel
//! `Vec<f64>` per channel. Every channel is therefore indexed by the same frame
//! number, which makes "what was everything doing at time t?" a single binary
//! search instead of one search per channel.
//!
//! Missing samples are stored as `f64::NAN` so the columns stay rectangular
//! even when a channel joins late or reports at a slower rate than the loop.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Summary of one channel, cheap enough to ship to the UI on every load.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMeta {
    pub name: String,
    pub unit: Option<String>,
    /// Finite minimum across the whole dataset, or 0.0 when the channel is empty.
    pub min: f64,
    pub max: f64,
    /// Number of finite samples (NaN gaps excluded).
    pub count: usize,
}

pub struct Channel {
    pub meta: ChannelMeta,
    pub values: Vec<f64>,
}

impl Channel {
    fn new(name: String, unit: Option<String>, backfill: usize) -> Self {
        Channel {
            meta: ChannelMeta {
                name,
                unit,
                min: f64::INFINITY,
                max: f64::NEG_INFINITY,
                count: 0,
            },
            values: vec![f64::NAN; backfill],
        }
    }

    fn observe(&mut self, v: f64) {
        if v.is_finite() {
            if v < self.meta.min {
                self.meta.min = v;
            }
            if v > self.meta.max {
                self.meta.max = v;
            }
            self.meta.count += 1;
        }
    }

    /// `min`/`max` start at infinities so the first sample wins; normalise the
    /// never-sampled case before handing metadata to the UI.
    pub fn meta_normalised(&self) -> ChannelMeta {
        let mut m = self.meta.clone();
        if m.count == 0 {
            m.min = 0.0;
            m.max = 0.0;
        }
        m
    }
}

/// A point of interest on the timeline: a flight state transition, a detected
/// milestone such as apogee, or a marker the operator dropped by hand.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightEvent {
    pub t: f64,
    pub label: String,
    /// `state` | `detected` | `marker`
    pub kind: String,
}

/// Metadata describing a loaded dataset, without any of the bulk samples.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetInfo {
    pub id: String,
    pub name: String,
    pub source: String,
    pub t0: f64,
    pub t1: f64,
    pub frames: usize,
    pub live: bool,
    pub channels: Vec<ChannelMeta>,
    pub events: Vec<FlightEvent>,
}

/// One channel's answer to a range query. `values` is aligned to the shared
/// `times` array returned alongside it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesData {
    pub name: String,
    pub unit: Option<String>,
    pub values: Vec<Option<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeQuery {
    pub times: Vec<f64>,
    pub series: Vec<SeriesData>,
    /// Frames actually covered by the range, before decimation.
    pub source_frames: usize,
    /// True when the response is min/max decimated rather than raw samples.
    pub decimated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStats {
    pub name: String,
    pub unit: Option<String>,
    pub count: usize,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
    pub stddev: Option<f64>,
    pub first: Option<f64>,
    pub last: Option<f64>,
    /// Time at which `min` occurred.
    pub t_min: Option<f64>,
    pub t_max: Option<f64>,
}

pub struct Dataset {
    pub id: String,
    pub name: String,
    pub source: String,
    pub times: Vec<f64>,
    pub channels: Vec<Channel>,
    index: HashMap<String, usize>,
    pub events: Vec<FlightEvent>,
    /// A live dataset is still being appended to by a running source.
    pub live: bool,
}

impl Dataset {
    pub fn new(id: impl Into<String>, name: impl Into<String>, source: impl Into<String>) -> Self {
        Dataset {
            id: id.into(),
            name: name.into(),
            source: source.into(),
            times: Vec::new(),
            channels: Vec::new(),
            index: HashMap::new(),
            events: Vec::new(),
            live: false,
        }
    }

    pub fn frames(&self) -> usize {
        self.times.len()
    }

    pub fn t0(&self) -> f64 {
        self.times.first().copied().unwrap_or(0.0)
    }

    pub fn t1(&self) -> f64 {
        self.times.last().copied().unwrap_or(0.0)
    }

    pub fn channel_names(&self) -> Vec<String> {
        self.channels.iter().map(|c| c.meta.name.clone()).collect()
    }

    pub fn channel(&self, name: &str) -> Option<&Channel> {
        self.index.get(name).map(|&i| &self.channels[i])
    }

    /// Fetch or create a channel, backfilling NaN so it lines up with `times`.
    pub fn ensure_channel(&mut self, name: &str, unit: Option<String>) -> usize {
        if let Some(&i) = self.index.get(name) {
            // A later declaration may carry a unit the first one lacked.
            if self.channels[i].meta.unit.is_none() {
                if let Some(u) = unit {
                    self.channels[i].meta.unit = Some(u);
                }
            }
            return i;
        }
        let backfill = self.times.len();
        self.channels
            .push(Channel::new(name.to_string(), unit, backfill));
        let i = self.channels.len() - 1;
        self.index.insert(name.to_string(), i);
        i
    }

    /// Append one control-loop frame. Channels absent from `values` get a NaN
    /// gap for this timestamp rather than a stale carry-forward, so the store
    /// records what was actually reported.
    pub fn push_frame(&mut self, t: f64, values: &[(String, f64)]) {
        for (name, _) in values {
            self.ensure_channel(name, None);
        }
        self.times.push(t);
        let n = self.times.len();
        for ch in self.channels.iter_mut() {
            ch.values.resize(n, f64::NAN);
        }
        for (name, v) in values {
            if let Some(&i) = self.index.get(name.as_str()) {
                self.channels[i].values[n - 1] = *v;
                self.channels[i].observe(*v);
            }
        }
    }

    /// Append a whole pre-parsed column at once. Much faster than `push_frame`
    /// in a loop for file loads, where every column length is already known.
    pub fn push_column(&mut self, name: &str, unit: Option<String>, values: Vec<f64>) {
        let i = self.ensure_channel(name, unit);
        for v in &values {
            self.channels[i].observe(*v);
        }
        self.channels[i].values = values;
        let n = self.times.len();
        self.channels[i].values.resize(n, f64::NAN);
    }

    pub fn info(&self) -> DatasetInfo {
        DatasetInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            source: self.source.clone(),
            t0: self.t0(),
            t1: self.t1(),
            frames: self.frames(),
            live: self.live,
            channels: self.channels.iter().map(|c| c.meta_normalised()).collect(),
            events: self.events.clone(),
        }
    }

    /// Index of the last frame at or before `t`, clamped into range.
    pub fn index_at(&self, t: f64) -> usize {
        if self.times.is_empty() {
            return 0;
        }
        match self
            .times
            .binary_search_by(|probe| probe.partial_cmp(&t).unwrap_or(std::cmp::Ordering::Less))
        {
            Ok(i) => i,
            Err(0) => 0,
            Err(i) => i - 1,
        }
    }

    /// Half-open `[start, end)` index window covering `[t0, t1]`.
    fn range_indices(&self, t0: f64, t1: f64) -> (usize, usize) {
        if self.times.is_empty() {
            return (0, 0);
        }
        let lo = self.times.partition_point(|&x| x < t0);
        let hi = self.times.partition_point(|&x| x <= t1);
        // Include one frame either side so lines reach the plot edges.
        let lo = lo.saturating_sub(1);
        let hi = (hi + 1).min(self.times.len());
        (lo, hi)
    }

    /// Range query with min/max decimation.
    ///
    /// Naive stride sampling drops the single-frame spikes that matter most in
    /// flight data (a pyro fire, a dropped packet, a g-spike), so each output
    /// bucket instead reports that bucket's extremes. The two samples are
    /// emitted in the order they actually occurred, which keeps the rendered
    /// line's direction faithful, and every channel shares one `times` array so
    /// the frontend can hand it straight to the plotter.
    pub fn query(
        &self,
        channels: &[String],
        t0: f64,
        t1: f64,
        max_points: usize,
    ) -> RangeQuery {
        let (lo, hi) = self.range_indices(t0, t1);
        let n = hi.saturating_sub(lo);
        let selected: Vec<usize> = channels
            .iter()
            .filter_map(|name| self.index.get(name.as_str()).copied())
            .collect();

        if n == 0 {
            return RangeQuery {
                times: Vec::new(),
                series: selected
                    .iter()
                    .map(|&i| SeriesData {
                        name: self.channels[i].meta.name.clone(),
                        unit: self.channels[i].meta.unit.clone(),
                        values: Vec::new(),
                    })
                    .collect(),
                source_frames: 0,
                decimated: false,
            };
        }

        let max_points = max_points.max(4);
        if n <= max_points {
            return RangeQuery {
                times: self.times[lo..hi].to_vec(),
                series: selected
                    .iter()
                    .map(|&i| SeriesData {
                        name: self.channels[i].meta.name.clone(),
                        unit: self.channels[i].meta.unit.clone(),
                        values: self.channels[i].values[lo..hi]
                            .iter()
                            .map(|v| if v.is_finite() { Some(*v) } else { None })
                            .collect(),
                    })
                    .collect(),
                source_frames: n,
                decimated: false,
            };
        }

        let buckets = max_points / 2;
        let mut times = Vec::with_capacity(buckets * 2);
        let mut out: Vec<Vec<Option<f64>>> = selected
            .iter()
            .map(|_| Vec::with_capacity(buckets * 2))
            .collect();

        for b in 0..buckets {
            let bs = lo + (n * b) / buckets;
            let be = (lo + (n * (b + 1)) / buckets).max(bs + 1).min(hi);
            times.push(self.times[bs]);
            times.push(self.times[be - 1]);

            for (slot, &ci) in selected.iter().enumerate() {
                let vals = &self.channels[ci].values[bs..be];
                let mut min_v = f64::INFINITY;
                let mut max_v = f64::NEG_INFINITY;
                let mut min_i = usize::MAX;
                let mut max_i = usize::MAX;
                for (k, v) in vals.iter().enumerate() {
                    if !v.is_finite() {
                        continue;
                    }
                    if *v < min_v {
                        min_v = *v;
                        min_i = k;
                    }
                    if *v > max_v {
                        max_v = *v;
                        max_i = k;
                    }
                }
                if min_i == usize::MAX {
                    out[slot].push(None);
                    out[slot].push(None);
                } else if min_i <= max_i {
                    out[slot].push(Some(min_v));
                    out[slot].push(Some(max_v));
                } else {
                    out[slot].push(Some(max_v));
                    out[slot].push(Some(min_v));
                }
            }
        }

        RangeQuery {
            times,
            series: selected
                .iter()
                .enumerate()
                .map(|(slot, &i)| SeriesData {
                    name: self.channels[i].meta.name.clone(),
                    unit: self.channels[i].meta.unit.clone(),
                    values: std::mem::take(&mut out[slot]),
                })
                .collect(),
            source_frames: n,
            decimated: true,
        }
    }

    /// Values at the playback cursor.
    ///
    /// A channel reporting slower than the control loop (GPS at 1 Hz inside a
    /// 200 Hz loop) leaves NaN gaps, so an exact-frame lookup would make
    /// readouts flicker between a value and nothing. Walk backwards up to
    /// `hold` seconds to find the last real sample instead.
    pub fn sample_at(&self, t: f64, channels: &[String], hold: f64) -> Vec<Option<f64>> {
        if self.times.is_empty() {
            return channels.iter().map(|_| None).collect();
        }
        let idx = self.index_at(t);
        let cutoff = self.times[idx] - hold;
        channels
            .iter()
            .map(|name| {
                let ci = *self.index.get(name.as_str())?;
                let vals = &self.channels[ci].values;
                let mut k = idx.min(vals.len().saturating_sub(1));
                loop {
                    if vals[k].is_finite() {
                        return Some(vals[k]);
                    }
                    if k == 0 || self.times[k] < cutoff {
                        return None;
                    }
                    k -= 1;
                }
            })
            .collect()
    }

    pub fn stats(&self, channels: &[String], t0: f64, t1: f64) -> Vec<ChannelStats> {
        let (lo, hi) = self.range_indices(t0, t1);
        channels
            .iter()
            .filter_map(|name| {
                let ci = *self.index.get(name.as_str())?;
                let ch = &self.channels[ci];
                let vals = &ch.values[lo.min(ch.values.len())..hi.min(ch.values.len())];

                let mut count = 0usize;
                let mut sum = 0.0f64;
                let mut min = f64::INFINITY;
                let mut max = f64::NEG_INFINITY;
                let (mut t_min, mut t_max) = (0.0f64, 0.0f64);
                let mut first = None;
                let mut last = None;
                for (k, v) in vals.iter().enumerate() {
                    if !v.is_finite() {
                        continue;
                    }
                    count += 1;
                    sum += *v;
                    if *v < min {
                        min = *v;
                        t_min = self.times[lo + k];
                    }
                    if *v > max {
                        max = *v;
                        t_max = self.times[lo + k];
                    }
                    if first.is_none() {
                        first = Some(*v);
                    }
                    last = Some(*v);
                }

                if count == 0 {
                    return Some(ChannelStats {
                        name: ch.meta.name.clone(),
                        unit: ch.meta.unit.clone(),
                        count: 0,
                        min: None,
                        max: None,
                        mean: None,
                        stddev: None,
                        first: None,
                        last: None,
                        t_min: None,
                        t_max: None,
                    });
                }

                let mean = sum / count as f64;
                let var = vals
                    .iter()
                    .filter(|v| v.is_finite())
                    .map(|v| (v - mean) * (v - mean))
                    .sum::<f64>()
                    / count as f64;

                Some(ChannelStats {
                    name: ch.meta.name.clone(),
                    unit: ch.meta.unit.clone(),
                    count,
                    min: Some(min),
                    max: Some(max),
                    mean: Some(mean),
                    stddev: Some(var.sqrt()),
                    first,
                    last,
                    t_min: Some(t_min),
                    t_max: Some(t_max),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dataset_with(times: Vec<f64>, name: &str, values: Vec<f64>) -> Dataset {
        let mut ds = Dataset::new("t", "test", "unit-test");
        ds.times = times;
        ds.push_column(name, Some("m".into()), values);
        ds
    }

    #[test]
    fn push_frame_backfills_late_channels() {
        let mut ds = Dataset::new("t", "test", "unit-test");
        ds.push_frame(0.0, &[("a".into(), 1.0)]);
        ds.push_frame(0.1, &[("a".into(), 2.0), ("b".into(), 9.0)]);

        // `b` appeared on the second frame, so its first sample must be a gap
        // rather than shifting the column out of alignment with `times`.
        let b = ds.channel("b").unwrap();
        assert_eq!(b.values.len(), 2);
        assert!(b.values[0].is_nan());
        assert_eq!(b.values[1], 9.0);
        assert_eq!(ds.channel("a").unwrap().values, vec![1.0, 2.0]);
    }

    #[test]
    fn index_at_clamps_and_finds_preceding_frame() {
        let ds = dataset_with(vec![0.0, 1.0, 2.0, 3.0], "a", vec![0.0; 4]);
        assert_eq!(ds.index_at(-5.0), 0);
        assert_eq!(ds.index_at(0.0), 0);
        assert_eq!(ds.index_at(1.5), 1);
        assert_eq!(ds.index_at(2.0), 2);
        assert_eq!(ds.index_at(99.0), 3);
    }

    #[test]
    fn query_returns_raw_samples_below_the_cap() {
        let ds = dataset_with(vec![0.0, 1.0, 2.0], "a", vec![1.0, 2.0, 3.0]);
        let q = ds.query(&["a".into()], 0.0, 2.0, 100);
        assert!(!q.decimated);
        assert_eq!(q.times.len(), 3);
        assert_eq!(q.series[0].values, vec![Some(1.0), Some(2.0), Some(3.0)]);
    }

    #[test]
    fn decimation_preserves_single_frame_spikes() {
        // A lone spike in an otherwise flat channel is exactly what stride
        // sampling loses and what flight review most needs to see.
        let n = 10_000;
        let times: Vec<f64> = (0..n).map(|i| i as f64 * 0.01).collect();
        let mut values = vec![0.0; n];
        values[4_321] = 500.0;
        values[7_777] = -250.0;
        let ds = dataset_with(times, "a", values);

        let q = ds.query(&["a".into()], 0.0, 100.0, 200);
        assert!(q.decimated);
        assert!(q.times.len() <= 200);

        let seen: Vec<f64> = q.series[0].values.iter().flatten().copied().collect();
        assert!(seen.contains(&500.0), "positive spike was dropped");
        assert!(seen.contains(&-250.0), "negative spike was dropped");
    }

    #[test]
    fn decimated_output_is_aligned_and_monotonic() {
        let n = 5_000;
        let times: Vec<f64> = (0..n).map(|i| i as f64 * 0.02).collect();
        let a: Vec<f64> = (0..n).map(|i| (i as f64 * 0.01).sin()).collect();
        let b: Vec<f64> = (0..n).map(|i| (i as f64 * 0.01).cos()).collect();
        let mut ds = Dataset::new("t", "test", "unit-test");
        ds.times = times;
        ds.push_column("a", None, a);
        ds.push_column("b", None, b);

        let q = ds.query(&["a".into(), "b".into()], 0.0, 100.0, 300);
        // Every channel shares one x array, which is what lets the frontend
        // hand the result straight to the plotter.
        for s in &q.series {
            assert_eq!(s.values.len(), q.times.len());
        }
        assert!(q.times.windows(2).all(|w| w[1] >= w[0]), "times must not go backwards");
    }

    #[test]
    fn sample_at_holds_the_last_real_value_across_gaps() {
        // A 1 Hz channel inside a 100 Hz loop: mostly gaps.
        let times: Vec<f64> = (0..10).map(|i| i as f64 * 0.1).collect();
        let mut values = vec![f64::NAN; 10];
        values[0] = 42.0;
        let ds = dataset_with(times, "gps", values);

        assert_eq!(ds.sample_at(0.85, &["gps".into()], f64::INFINITY), vec![Some(42.0)]);
        // With a short hold window the stale sample is correctly reported as absent.
        assert_eq!(ds.sample_at(0.85, &["gps".into()], 0.2), vec![None]);
    }

    #[test]
    fn sample_at_reports_unknown_channels_as_none() {
        let ds = dataset_with(vec![0.0, 1.0], "a", vec![1.0, 2.0]);
        assert_eq!(ds.sample_at(0.5, &["nope".into()], f64::INFINITY), vec![None]);
    }

    #[test]
    fn stats_ignore_gaps() {
        let times: Vec<f64> = (0..5).map(|i| i as f64).collect();
        let ds = dataset_with(times, "a", vec![1.0, f64::NAN, 3.0, f64::NAN, 5.0]);
        let s = &ds.stats(&["a".into()], 0.0, 4.0)[0];

        assert_eq!(s.count, 3);
        assert_eq!(s.min, Some(1.0));
        assert_eq!(s.max, Some(5.0));
        assert_eq!(s.mean, Some(3.0));
        assert_eq!(s.t_min, Some(0.0));
        assert_eq!(s.t_max, Some(4.0));
    }

    #[test]
    fn stats_on_an_all_gap_window_report_no_samples() {
        let ds = dataset_with(vec![0.0, 1.0], "a", vec![f64::NAN, f64::NAN]);
        let s = &ds.stats(&["a".into()], 0.0, 1.0)[0];
        assert_eq!(s.count, 0);
        assert!(s.mean.is_none());
    }

    #[test]
    fn empty_dataset_queries_do_not_panic() {
        let ds = Dataset::new("t", "empty", "unit-test");
        let q = ds.query(&["a".into()], 0.0, 1.0, 100);
        assert!(q.times.is_empty());
        assert_eq!(ds.index_at(5.0), 0);
        assert!(ds.stats(&["a".into()], 0.0, 1.0).is_empty());
    }

    #[test]
    fn never_sampled_channels_report_a_zero_range() {
        let mut ds = Dataset::new("t", "test", "unit-test");
        ds.ensure_channel("a", None);
        let m = ds.channels[0].meta_normalised();
        assert_eq!((m.min, m.max, m.count), (0.0, 0.0, 0));
    }
}
