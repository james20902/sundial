/**
 * Single-value readout.
 *
 * The headline number is the point, so it scales with the widget and everything
 * else stays recessive. The optional sparkline gives the value context — a
 * number alone cannot tell you whether 412 m is on the way up or down.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Widget } from "@/state/store";
import { useData, usePlayback } from "@/state/store";
import { useDemandChannels } from "@/state/sampler";
import { useSeries } from "./useSeries";
import { colorsFor } from "./colors";
import { CHART, fmt } from "./chartTheme";

export function Readout({ widget }: { widget: Widget }) {
  const channel = widget.channels[0];
  const o = widget.options;
  const info = useData((s) => s.info);
  const value = useData((s) => (channel ? s.samples[channel] ?? null : null));
  const viewT0 = usePlayback((s) => s.viewT0);
  const viewT1 = usePlayback((s) => s.viewT1);

  const channels = useMemo(() => (channel ? [channel] : []), [channel]);
  useDemandChannels(channels);

  const hostRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 200, h: 100 });
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setBox({ w: e.contentRect.width, h: e.contentRect.height }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const meta = info?.channels.find((c) => c.name === channel);
  const color = colorsFor(channels, o.colorMap)[0] ?? CHART.cursor;

  // Size the headline to the widget, bounded so it stays legible in a small
  // tile and does not overflow a large one.
  const fontSize = Math.max(18, Math.min(box.h * 0.4, box.w * 0.22, 68));

  if (!channel) {
    return (
      <div className="empty-hint">
        <div>No channel selected</div>
        <div>Open settings to pick a data source.</div>
      </div>
    );
  }

  return (
    <div className="readout" ref={hostRef}>
      <div className="readout-value" style={{ fontSize }}>
        <span>{fmt(value, o.precision ?? 2)}</span>
        {meta?.unit && <span className="readout-unit">{meta.unit}</span>}
      </div>
      {o.showExtremes !== false && (
        <ViewExtremes channel={channel} t0={viewT0} t1={viewT1} precision={o.precision} />
      )}
      {o.showSparkline !== false && (
        <Sparkline
          channel={channel}
          t0={viewT0}
          t1={viewT1}
          color={color}
          width={Math.max(40, box.w - 24)}
          height={Math.min(34, Math.max(16, box.h * 0.22))}
        />
      )}
    </div>
  );
}

function ViewExtremes({
  channel,
  t0,
  t1,
  precision,
}: {
  channel: string;
  t0: number;
  t1: number;
  precision?: number;
}) {
  const { data } = useSeries([channel], t0, t1, 400);
  const [lo, hi] = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const v of data?.series[0]?.values ?? []) {
      if (v === null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return Number.isFinite(min) ? [min, max] : [null, null];
  }, [data]);

  return (
    <div className="readout-extremes">
      <span>min {fmt(lo, precision)}</span>
      <span>max {fmt(hi, precision)}</span>
    </div>
  );
}

function Sparkline({
  channel,
  t0,
  t1,
  color,
  width,
  height,
}: {
  channel: string;
  t0: number;
  t1: number;
  color: string;
  width: number;
  height: number;
}) {
  const { data } = useSeries([channel], t0, t1, Math.max(32, Math.round(width)));
  const cursor = usePlayback((s) => s.cursor);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(height * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const vals = data?.series[0]?.values ?? [];
    const times = data?.times ?? [];
    if (vals.length < 2) return;

    let lo = Infinity;
    let hi = -Infinity;
    for (const v of vals) {
      if (v === null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) return;
    const span = hi - lo || 1;
    const px = (i: number) => (i / (vals.length - 1)) * width;
    const py = (v: number) => height - 1 - ((v - lo) / span) * (height - 2);

    ctx.beginPath();
    let started = false;
    vals.forEach((v, i) => {
      if (v === null) {
        started = false;
        return;
      }
      if (!started) {
        ctx.moveTo(px(i), py(v));
        started = true;
      } else {
        ctx.lineTo(px(i), py(v));
      }
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Mark where the playback cursor sits within the sparkline's window.
    if (times.length && cursor >= times[0] && cursor <= times[times.length - 1]) {
      const frac = (cursor - times[0]) / (times[times.length - 1] - times[0] || 1);
      ctx.strokeStyle = CHART.cursor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(frac * width, 0);
      ctx.lineTo(frac * width, height);
      ctx.stroke();
    }
  }, [data, width, height, color, cursor]);

  return <canvas className="readout-spark" ref={ref} style={{ width, height }} />;
}
