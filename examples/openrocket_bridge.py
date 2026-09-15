#!/usr/bin/env python3
"""Stream simulation data into Sundial's live UDP source.

Sundial's live-source hook takes one JSON object per control-loop frame over
UDP. Anything that can send a datagram can drive it, which is how a simulator
feed gets in: run this while Sundial is listening (Live source... in the
header, default 127.0.0.1:9870).

    python3 examples/openrocket_bridge.py

To bridge a real OpenRocket run, replace `frames()` with something that reads
the simulation — an OpenRocket simulation listener, or a CSV it exported —
and yield the same dicts. Keys become channels; `t` is seconds; an `event` key
drops a marker on the timeline.

To add a different transport altogether (serial radio, MQTT, a socket the
flight computer already speaks), implement `LiveSource` in
`src-tauri/src/sources/` and register it in `build_source` — `udp.rs` is a
complete worked example at about 80 lines.
"""

import json
import math
import socket
import time

ADDR = ("127.0.0.1", 9870)
RATE = 50  # frames per second


def frames():
    """Yield one dict per control-loop iteration.

    Replace this with your simulator's output. The timestamps are the
    simulation's own clock, not wall clock — Sundial timestamps nothing itself.
    """
    t = 0.0
    alt = vel = 0.0
    dt = 1.0 / RATE
    while t < 60.0:
        if t < 3.0:
            accel = 0.0
        elif t < 6.0:
            accel = 80.0 - 9.81
        else:
            accel = -9.81 - 0.0002 * vel * abs(vel)

        if t >= 3.0:
            vel += accel * dt
            alt = max(0.0, alt + vel * dt)

        frame = {
            "t": round(t, 4),
            "altitude": round(alt, 3),
            "velocity": round(vel, 3),
            "accel_z": round(accel + 9.81, 3),
            "pressure": round(101325 * math.exp(-alt / 8434.0), 1),
            "mach": round(max(0.0, vel) / 330.0, 4),
        }
        if abs(t - 3.0) < dt / 2:
            frame["event"] = "LAUNCH"
        elif abs(t - 6.0) < dt / 2:
            frame["event"] = "BURNOUT"

        yield frame
        t += dt


def main() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    print(f"streaming to {ADDR[0]}:{ADDR[1]} at {RATE} Hz — start the UDP source in Sundial first")
    sent = 0
    for frame in frames():
        sock.sendto(json.dumps(frame).encode(), ADDR)
        sent += 1
        # Pace to the loop rate so the timeline advances in real time.
        time.sleep(1.0 / RATE)
    print(f"sent {sent} frames")


if __name__ == "__main__":
    main()
