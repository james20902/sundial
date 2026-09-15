//! Telemetry ingest.
//!
//! Two shapes of source exist, because they have genuinely different lifetimes:
//!
//! * **Loaders** ([`file`]) read a finished flight log into a [`Dataset`] in one
//!   go. This is Sundial's primary path.
//! * **Live sources** ([`LiveSource`]) stream frames in over time and extend a
//!   dataset while it is being viewed. This is the hook for simulation feeds —
//!   an OpenRocket bridge, a SITL rig, or a hardware-in-the-loop harness.
//!
//! Adding a simulator means implementing [`LiveSource`] and registering it in
//! [`build_source`]; nothing else in the app needs to change. See [`udp`] for a
//! complete worked example.

pub mod file;
pub mod udp;

use crate::store::{Dataset, FlightEvent};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;

/// One control-loop iteration: a timestamp plus every datapoint tagged to it.
#[derive(Debug, Clone)]
pub struct Frame {
    pub t: f64,
    pub values: Vec<(String, f64)>,
    pub event: Option<String>,
}

/// Where a [`LiveSource`] hands frames to the application.
///
/// The sink is cheap to call and never blocks on the UI: frames go into a
/// channel that a single ingest thread drains, so a source running at control
/// loop rate cannot stall on rendering.
pub struct FrameSink {
    tx: Sender<Frame>,
    stop: Arc<AtomicBool>,
}

impl FrameSink {
    /// Push one frame. Returns `false` once the receiving end has gone away,
    /// which is the signal for a source's `run` loop to return.
    pub fn push(&self, t: f64, values: Vec<(String, f64)>) -> bool {
        self.tx.send(Frame { t, values, event: None }).is_ok()
    }

    /// Push a frame that also marks a flight event on the timeline.
    pub fn push_with_event(&self, t: f64, values: Vec<(String, f64)>, event: String) -> bool {
        self.tx.send(Frame { t, values, event: Some(event) }).is_ok()
    }

    /// True once the operator has stopped this source; long-running `run`
    /// implementations should check it between reads.
    pub fn is_stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }
}

/// A streaming telemetry feed.
///
/// Implementors block inside [`run`](LiveSource::run) on a dedicated thread and
/// push frames into the sink until stopped. Returning `Ok(())` means the feed
/// ended normally (a simulation finished); returning `Err` surfaces the message
/// in the UI.
pub trait LiveSource: Send {
    /// Stable machine identifier, e.g. `"udp"`.
    fn kind(&self) -> &'static str;

    /// Human-readable description shown in the source bar.
    fn describe(&self) -> String;

    fn run(&mut self, sink: &FrameSink) -> Result<(), String>;
}

/// Configuration for starting a live source, as sent from the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSourceConfig {
    /// Which implementation to start, e.g. `"udp"`.
    pub kind: String,
    /// Implementation-specific options.
    #[serde(default)]
    pub options: serde_json::Value,
}

/// Construct a live source from its UI configuration.
///
/// **This is the extension point.** To plug in a simulator, add a match arm
/// here returning your [`LiveSource`] implementation, and add a matching entry
/// to the source picker in `src/app/SourceBar.tsx`.
pub fn build_source(cfg: &LiveSourceConfig) -> Result<Box<dyn LiveSource>, String> {
    match cfg.kind.as_str() {
        "udp" => Ok(Box::new(udp::UdpSource::from_options(&cfg.options)?)),
        other => Err(format!(
            "unknown live source '{other}'. Implement LiveSource and register it in sources::build_source."
        )),
    }
}

/// Handle to a running live source. Dropping it stops the feed.
pub struct LiveHandle {
    pub dataset_id: String,
    pub kind: String,
    pub description: String,
    stop: Arc<AtomicBool>,
}

impl LiveHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Start `source` on its own thread, returning a handle plus the receiver the
/// caller drains into the store.
pub fn spawn(
    mut source: Box<dyn LiveSource>,
    dataset_id: String,
) -> (LiveHandle, Receiver<Frame>, Receiver<Result<(), String>>) {
    let (tx, rx) = mpsc::channel::<Frame>();
    let (done_tx, done_rx) = mpsc::channel::<Result<(), String>>();
    let stop = Arc::new(AtomicBool::new(false));

    let handle = LiveHandle {
        dataset_id,
        kind: source.kind().to_string(),
        description: source.describe(),
        stop: stop.clone(),
    };

    let sink = FrameSink { tx, stop: stop.clone() };
    std::thread::Builder::new()
        .name("sundial-live-source".into())
        .spawn(move || {
            let result = source.run(&sink);
            let _ = done_tx.send(result);
        })
        .expect("failed to spawn live source thread");

    (handle, rx, done_rx)
}

/// Apply a frame to a dataset, recording any event it carries.
pub fn apply_frame(ds: &mut Dataset, frame: Frame) {
    if let Some(label) = &frame.event {
        ds.events.push(FlightEvent { t: frame.t, label: label.clone(), kind: "state".into() });
    }
    ds.push_frame(frame.t, &frame.values);
}
