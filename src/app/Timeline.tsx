/**
 * Global timeline.
 *
 * The seek bar always represents the whole flight, with the currently-zoomed
 * view drawn as a window on top of it. That way the operator never loses track
 * of where they are in the flight while zoomed into a 200 ms window — which is
 * the failure mode of a seek bar that rescales to the zoom.
 *
 * Interactions: click or drag anywhere to scrub, drag the window body to pan,
 * drag its edges to zoom, wheel to zoom about the pointer, double-click to fit
 * the whole flight.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useActiveTab, useData, usePlayback } from "@/state/store";
import { useSeries } from "@/widgets/useSeries";
import { CHART, fmtTime } from "@/widgets/chartTheme";
import { findChannel } from "@/state/store";
import { addMarker } from "@/data/client";

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25];
const EDGE_PX = 6;

type Mode = "scrub" | "pan" | "resize-l" | "resize-r";

export function Timeline() {
  const info = useData((s) => s.info);
  const setEvents = useData((s) => s.setEvents);
  const tab = useActiveTab();

  const cursor = usePlayback((s) => s.cursor);
  const playing = usePlayback((s) => s.playing);
  const speed = usePlayback((s) => s.speed);
  const viewT0 = usePlayback((s) => s.viewT0);
  const viewT1 = usePlayback((s) => s.viewT1);
  const follow = usePlayback((s) => s.follow);
  const setCursor = usePlayback((s) => s.setCursor);
  const setPlaying = usePlayback((s) => s.setPlaying);
  const setSpeed = usePlayback((s) => s.setSpeed);
  const setView = usePlayback((s) => s.setView);
  const setFollow = usePlayback((s) => s.setFollow);

  const seekRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(900);
  const [h, setH] = useState(44);
  const dragRef = useRef<{ mode: Mode; grabT: number; span: number } | null>(null);

  const t0 = info?.t0 ?? 0;
  const t1 = info?.t1 ?? 1;
  const span = Math.max(1e-9, t1 - t0);

  useLayoutEffect(() => {
    const el = seekRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setW(Math.max(80, Math.floor(e.contentRect.width)));
      setH(Math.max(24, Math.floor(e.contentRect.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Overview channel: whatever the active tab plots first, else an altitude. */
  const overviewChannel = useMemo(() => {
    const plotted = tab?.widgets.find((x) => x.kind === "timeseries" && x.channels.length);
    if (plotted) return plotted.channels[0];
    if (!info) return undefined;
    return (
      findChannel(info.channels, ["altitude", "alt", "height"]) ?? info.channels[0]?.name
    );
  }, [tab, info]);

  const overviewChannels = useMemo(
    () => (overviewChannel ? [overviewChannel] : []),
    [overviewChannel],
  );
  const { data: overview } = useSeries(overviewChannels, t0, t1, Math.max(120, w * 2));

  const toT = useCallback((clientX: number) => {
    const rect = seekRef.current?.getBoundingClientRect();
    if (!rect) return t0;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return t0 + frac * span;
  }, [t0, span]);

  const toX = useCallback((t: number) => ((t - t0) / span) * w, [t0, span, w]);

  // --- painting ------------------------------------------------------------
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Overview trace
    const vals = overview?.series[0]?.values ?? [];
    if (vals.length > 1) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of vals) {
        if (v === null) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (Number.isFinite(lo)) {
        const vSpan = hi - lo || 1;
        const times = overview!.times;
        const py = (v: number) => h - 3 - ((v - lo) / vSpan) * (h - 8);
        ctx.beginPath();
        ctx.moveTo(0, h);
        let started = false;
        vals.forEach((v, i) => {
          if (v === null) return;
          const x = toX(times[i]);
          if (!started) {
            ctx.lineTo(x, py(v));
            started = true;
          } else ctx.lineTo(x, py(v));
        });
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = "rgba(57, 135, 229, 0.16)";
        ctx.fill();

        ctx.beginPath();
        started = false;
        vals.forEach((v, i) => {
          if (v === null) {
            started = false;
            return;
          }
          const x = toX(times[i]);
          if (!started) {
            ctx.moveTo(x, py(v));
            started = true;
          } else ctx.lineTo(x, py(v));
        });
        ctx.strokeStyle = "#3987e5";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Event ticks
    for (const ev of info?.events ?? []) {
      const x = toX(ev.t);
      ctx.strokeStyle =
        ev.kind === "detected" ? CHART.eventDetected : ev.kind === "marker" ? "#199e70" : CHART.event;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h * 0.32);
      ctx.stroke();
    }

    // Time ruler
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.fillStyle = CHART.tick;
    const targetTicks = Math.max(2, Math.floor(w / 90));
    const rawStep = span / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) ?? mag * 10;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = toX(t);
      ctx.strokeStyle = "rgba(109, 119, 135, 0.28)";
      ctx.beginPath();
      ctx.moveTo(x, h - 11);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(fmtTime(t), x + 3, h - 3);
    }
  }, [w, h, overview, info, toX, span, t0, t1]);

  // --- pointer interaction --------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (!info) return;
    const rect = seekRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const xl = toX(viewT0);
    const xr = toX(viewT1);
    const zoomed = viewT1 - viewT0 < span * 0.999;

    let mode: Mode = "scrub";
    if (zoomed) {
      if (Math.abs(x - xl) <= EDGE_PX) mode = "resize-l";
      else if (Math.abs(x - xr) <= EDGE_PX) mode = "resize-r";
      else if (x > xl && x < xr) mode = "pan";
    }

    const grabT = toT(e.clientX);
    dragRef.current = { mode, grabT, span: viewT1 - viewT0 };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    if (mode === "scrub") {
      setFollow(false);
      setCursor(clampT(grabT));
    }
  };

  const clampT = (t: number) => Math.min(t1, Math.max(t0, t));

  const onPointerMove = (e: React.PointerEvent) => {
    const rect = seekRef.current?.getBoundingClientRect();
    if (!rect) return;
    const d = dragRef.current;
    const t = toT(e.clientX);

    if (!d) {
      // Hover affordance for the window edges.
      const x = e.clientX - rect.left;
      const near =
        Math.abs(x - toX(viewT0)) <= EDGE_PX || Math.abs(x - toX(viewT1)) <= EDGE_PX;
      (e.currentTarget as HTMLElement).style.cursor = near
        ? "ew-resize"
        : x > toX(viewT0) && x < toX(viewT1) && viewT1 - viewT0 < span * 0.999
          ? "grab"
          : "crosshair";
      return;
    }

    if (d.mode === "scrub") {
      setCursor(clampT(t));
    } else if (d.mode === "pan") {
      const shift = t - d.grabT;
      let a = viewT0 + shift;
      let b = a + d.span;
      if (a < t0) {
        a = t0;
        b = a + d.span;
      }
      if (b > t1) {
        b = t1;
        a = b - d.span;
      }
      setView(a, b);
      dragRef.current = { ...d, grabT: t };
    } else if (d.mode === "resize-l") {
      setView(Math.min(clampT(t), viewT1 - span * 1e-4), viewT1);
    } else {
      setView(viewT0, Math.max(clampT(t), viewT0 + span * 1e-4));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!info) return;
    e.preventDefault();
    const pivot = toT(e.clientX);
    const factor = e.deltaY > 0 ? 1.22 : 1 / 1.22;
    const cur = viewT1 - viewT0;
    const next = Math.min(span, Math.max(span * 1e-5, cur * factor));
    const frac = cur > 0 ? (pivot - viewT0) / cur : 0.5;
    let a = pivot - frac * next;
    let b = a + next;
    if (a < t0) {
      a = t0;
      b = a + next;
    }
    if (b > t1) {
      b = t1;
      a = Math.max(t0, b - next);
    }
    setView(a, b);
  };

  const zoomBy = (factor: number) => {
    const cur = viewT1 - viewT0;
    const next = Math.min(span, Math.max(span * 1e-5, cur * factor));
    const mid = Math.min(Math.max(cursor, viewT0), viewT1);
    let a = Math.max(t0, mid - next / 2);
    const b = Math.min(t1, a + next);
    a = Math.max(t0, b - next);
    setView(a, b);
  };

  const step = (frames: number) => {
    if (!info || info.frames < 2) return;
    const dt = (info.t1 - info.t0) / (info.frames - 1);
    setFollow(false);
    setCursor(clampT(cursor + frames * dt));
  };

  const jumpEvent = (dir: 1 | -1) => {
    const evs = info?.events ?? [];
    if (!evs.length) return;
    const next =
      dir > 0
        ? evs.find((e) => e.t > cursor + 1e-6)
        : [...evs].reverse().find((e) => e.t < cursor - 1e-6);
    if (next) {
      setFollow(false);
      setCursor(next.t);
    }
  };

  const viewIsFull = viewT1 - viewT0 >= span * 0.999;
  const frameIndex =
    info && info.frames > 1
      ? Math.round(((cursor - info.t0) / (info.t1 - info.t0)) * (info.frames - 1))
      : 0;

  return (
    <div className="timeline">
      <div className="transport">
        <button
          className="btn icon"
          title="Jump to previous event  (,)"
          onClick={() => jumpEvent(-1)}
          disabled={!info}
        >
          ⤒
        </button>
        <button
          className="btn icon"
          title="Step back one frame  (←)"
          onClick={() => step(-1)}
          disabled={!info}
        >
          ◀|
        </button>
        <button
          className="btn primary"
          title="Play / pause  (space)"
          onClick={() => setPlaying(!playing)}
          disabled={!info}
          style={{ minWidth: 40, justifyContent: "center" }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button
          className="btn icon"
          title="Step forward one frame  (→)"
          onClick={() => step(1)}
          disabled={!info}
        >
          |▶
        </button>
        <button
          className="btn icon"
          title="Jump to next event  (.)"
          onClick={() => jumpEvent(1)}
          disabled={!info}
        >
          ⤓
        </button>

        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          title="Playback rate"
          style={{ width: 74 }}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>

        <span className="transport-time">{fmtTime(cursor)}</span>
        <span className="transport-sub">
          frame {frameIndex.toLocaleString()}
          {info ? ` / ${(info.frames - 1).toLocaleString()}` : ""}
        </span>

        <span className="spacer" />

        <span className="transport-sub">
          view {fmtTime(viewT0)} – {fmtTime(viewT1)}
        </span>
        <button className="btn icon" title="Zoom in" onClick={() => zoomBy(1 / 1.6)} disabled={!info}>
          +
        </button>
        <button className="btn icon" title="Zoom out" onClick={() => zoomBy(1.6)} disabled={!info}>
          −
        </button>
        <button
          className="btn"
          title="Fit the whole flight  (F)"
          onClick={() => setView(t0, t1)}
          disabled={!info || viewIsFull}
        >
          Fit
        </button>
        <button
          className="btn"
          title="Drop a marker at the cursor  (M)"
          disabled={!info}
          onClick={() => {
            const label = window.prompt("Marker label", `Marker ${fmtTime(cursor)}`);
            if (label) addMarker(cursor, label, info?.id).then(setEvents).catch(() => {});
          }}
        >
          ⚑ Mark
        </button>
        {info?.live && (
          <button
            className={`btn${follow ? " active" : ""}`}
            title="Keep the cursor pinned to the newest sample"
            onClick={() => setFollow(!follow)}
          >
            Follow
          </button>
        )}
      </div>

      <div
        className="seek"
        ref={seekRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={() => setView(t0, t1)}
        title="Click to seek · drag the window to pan · wheel to zoom · double-click to fit"
      >
        <canvas ref={canvasRef} />
        {!viewIsFull && (
          <div
            className="seek-window"
            style={{ left: toX(viewT0), width: Math.max(2, toX(viewT1) - toX(viewT0)) }}
          />
        )}
        <div className="seek-cursor" style={{ left: toX(cursor) }} />
      </div>
    </div>
  );
}
