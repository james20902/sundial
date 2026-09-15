//! UDP telemetry ingest — the reference [`LiveSource`](super::LiveSource).
//!
//! Each datagram is one JSON object describing a single control-loop frame,
//! identical in shape to a line of a `.jsonl` log:
//!
//! ```json
//! {"t": 12.84, "altitude": 431.2, "accel_z": 1.02, "event": "APOGEE"}
//! ```
//!
//! `t` is seconds and may be omitted, in which case arrival order is used.
//! Any numeric field becomes a channel; booleans become 0/1; `event` drops a
//! marker on the timeline. Nesting values under `"values"` also works.
//!
//! # Bridging a simulator
//!
//! This is the intended path for feeding OpenRocket or a SITL rig into Sundial.
//! OpenRocket exposes a simulation listener API, so a bridge is a few lines in
//! whatever language drives the sim — anything that can send a datagram works:
//!
//! ```python
//! import json, socket
//! sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
//! for step in simulation:
//!     frame = {"t": step.time, "altitude": step.altitude, "mach": step.mach}
//!     sock.sendto(json.dumps(frame).encode(), ("127.0.0.1", 9870))
//! ```
//!
//! Start the listener from the source bar, then run the bridge.

use super::{FrameSink, LiveSource};
use std::net::UdpSocket;
use std::time::Duration;

pub struct UdpSource {
    bind: String,
    socket: Option<UdpSocket>,
    /// Frame counter used when datagrams carry no timestamp.
    seq: u64,
}

impl UdpSource {
    pub fn new(bind: impl Into<String>) -> Self {
        UdpSource { bind: bind.into(), socket: None, seq: 0 }
    }

    pub fn from_options(options: &serde_json::Value) -> Result<Self, String> {
        let bind = options
            .get("bind")
            .and_then(|v| v.as_str())
            .unwrap_or("127.0.0.1:9870")
            .to_string();
        Ok(UdpSource::new(bind))
    }
}

impl LiveSource for UdpSource {
    fn kind(&self) -> &'static str {
        "udp"
    }

    fn describe(&self) -> String {
        format!("UDP {}", self.bind)
    }

    fn run(&mut self, sink: &FrameSink) -> Result<(), String> {
        let socket = UdpSocket::bind(&self.bind)
            .map_err(|e| format!("cannot bind {}: {e}", self.bind))?;
        // A read timeout is what makes the stop flag responsive; without it the
        // thread would park in recv_from until the next datagram arrived.
        socket
            .set_read_timeout(Some(Duration::from_millis(200)))
            .map_err(|e| e.to_string())?;
        self.socket = Some(socket);
        let socket = self.socket.as_ref().unwrap();

        let mut buf = vec![0u8; 64 * 1024];
        while !sink.is_stopped() {
            let n = match socket.recv_from(&mut buf) {
                Ok((n, _)) => n,
                Err(e) => match e.kind() {
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => continue,
                    _ => return Err(format!("recv failed: {e}")),
                },
            };

            let text = match std::str::from_utf8(&buf[..n]) {
                Ok(s) => s.trim(),
                Err(_) => continue, // ignore a garbled datagram rather than dying
            };
            if text.is_empty() {
                continue;
            }

            let parsed: serde_json::Value = match serde_json::from_str(text) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let Some(obj) = parsed.as_object() else { continue };

            let t = obj
                .get("t")
                .or_else(|| obj.get("time"))
                .or_else(|| obj.get("timestamp"))
                .and_then(|v| v.as_f64())
                .unwrap_or(self.seq as f64);
            self.seq += 1;

            let mut values: Vec<(String, f64)> = Vec::new();
            let take = |k: &str, v: &serde_json::Value, out: &mut Vec<(String, f64)>| {
                if matches!(k, "t" | "time" | "timestamp" | "event") {
                    return;
                }
                match v {
                    serde_json::Value::Number(num) => {
                        if let Some(f) = num.as_f64() {
                            if f.is_finite() {
                                out.push((k.to_string(), f));
                            }
                        }
                    }
                    serde_json::Value::Bool(b) => {
                        out.push((k.to_string(), if *b { 1.0 } else { 0.0 }))
                    }
                    _ => {}
                }
            };

            if let Some(nested) = obj.get("values").and_then(|v| v.as_object()) {
                for (k, v) in nested {
                    take(k, v, &mut values);
                }
            }
            for (k, v) in obj {
                if k != "values" {
                    take(k, v, &mut values);
                }
            }

            let delivered = match obj.get("event").and_then(|v| v.as_str()) {
                Some(ev) => sink.push_with_event(t, values, ev.to_string()),
                None => sink.push(t, values),
            };
            if !delivered {
                break; // application shut the ingest side down
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::{spawn, LiveSourceConfig};
    use std::time::Instant;

    /// Ask the OS for a free port so tests do not collide with each other or
    /// with a running instance of the app.
    fn free_port() -> u16 {
        UdpSocket::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    #[test]
    fn datagrams_become_frames() {
        let port = free_port();
        let source = Box::new(UdpSource::new(format!("127.0.0.1:{port}")));
        let (handle, rx, done) = spawn(source, "live-test".into());

        let tx = UdpSocket::bind("127.0.0.1:0").unwrap();
        let target = format!("127.0.0.1:{port}");
        // The listener binds inside its own thread, so retry briefly rather
        // than racing it with a fixed sleep.
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut frame = None;
        while Instant::now() < deadline {
            tx.send_to(
                br#"{"t": 1.5, "altitude": 120.25, "armed": true, "event": "LAUNCH", "note": "ignored"}"#,
                &target,
            )
            .unwrap();
            if let Ok(f) = rx.recv_timeout(Duration::from_millis(150)) {
                frame = Some(f);
                break;
            }
        }

        let frame = frame.expect("no frame arrived within 5s");
        assert_eq!(frame.t, 1.5);
        assert_eq!(frame.event.as_deref(), Some("LAUNCH"));

        let values: std::collections::HashMap<_, _> = frame.values.into_iter().collect();
        assert_eq!(values.get("altitude"), Some(&120.25));
        // Booleans are usable as 0/1 channels; non-numeric fields are dropped.
        assert_eq!(values.get("armed"), Some(&1.0));
        assert!(!values.contains_key("note"));
        assert!(!values.contains_key("event"));

        handle.stop();
        assert!(done.recv_timeout(Duration::from_secs(5)).unwrap().is_ok());
    }

    #[test]
    fn malformed_datagrams_are_ignored_without_killing_the_feed() {
        let port = free_port();
        let source = Box::new(UdpSource::new(format!("127.0.0.1:{port}")));
        let (handle, rx, _done) = spawn(source, "live-test".into());

        let tx = UdpSocket::bind("127.0.0.1:0").unwrap();
        let target = format!("127.0.0.1:{port}");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut got = None;
        while Instant::now() < deadline {
            let _ = tx.send_to(b"not json", &target);
            let _ = tx.send_to(b"[1,2,3]", &target); // valid JSON, wrong shape
            let _ = tx.send_to(br#"{"t": 9.0, "a": 3}"#, &target);
            if let Ok(f) = rx.recv_timeout(Duration::from_millis(150)) {
                got = Some(f);
                break;
            }
        }

        let frame = got.expect("the good datagram never arrived");
        assert_eq!(frame.t, 9.0);
        handle.stop();
    }

    #[test]
    fn an_unknown_source_kind_is_reported_rather_than_panicking() {
        let cfg = LiveSourceConfig {
            kind: "carrier-pigeon".into(),
            options: serde_json::json!({}),
        };
        let err = crate::sources::build_source(&cfg).err().expect("should not build");
        assert!(err.contains("carrier-pigeon"), "got: {err}");
        assert!(err.contains("LiveSource"), "error should point at the extension point");
    }

    #[test]
    fn bind_address_defaults_when_options_are_empty() {
        let s = UdpSource::from_options(&serde_json::json!({})).unwrap();
        assert_eq!(s.describe(), "UDP 127.0.0.1:9870");
    }
}
