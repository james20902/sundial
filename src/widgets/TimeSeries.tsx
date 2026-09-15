/**
 * Time-series plot.
 *
 * Deliberately single-y-axis: a second scale makes two unrelated series look
 * correlated, so channels of different magnitude are either split across
 * widgets or compared with the `normalize` option, which scales each series to
 * 0..1 and says so on the axis.
 *
 * The playback cursor is a DOM overlay rather than a canvas redraw — it moves
 * every frame during playback, and repainting the whole plot for a 1px line
 * would dominate the frame budget. Event markers, which only move when the
 * window does, are drawn into the canvas.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Widget } from "@/state/store";
import { useData, usePlayback } from "@/state/store";
import { useDemandChannels } from "@/state/sampler";
import { useSeries } from "./useSeries";
import { colorsFor } from "./colors";
import { CHART, axisValues, fmt, fmtTime } from "./chartTheme";

interface Props {
  widget: Widget;
}

/** uPlot carries the device pixel ratio it rendered at, but not in its typings.
 *  Canvas-space values have to be divided by it to reach CSS pixels. */
function pxRatioOf(u: uPlot): number {
  return (u as uPlot & { pxRatio?: number }).pxRatio || window.devicePixelRatio || 1;
}

export function TimeSeries({ widget }: Props) {
  const info = useData((s) => s.info);
  const viewT0 = usePlayback((s) => s.viewT0);
  const viewT1 = usePlayback((s) => s.viewT1);
  const cursor = usePlayback((s) => s.cursor);
  const setCursor = usePlayback((s) => s.setCursor);

  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const cursorLineRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 300, h: 160 });

  const o = widget.options;
  const channels = widget.channels;

  // The legend reports each series' value at the cursor, which comes from the
  // shared sampler rather than from the (decimated) plot data.
  useDemandChannels(channels);

  const [t0, t1] = useMemo(() => {
    if (!info) return [0, 1];
    if (o.windowMode === "full") return [info.t0, info.t1];
    if (o.windowMode === "trailing") {
      const span = o.trailing ?? 10;
      return [cursor - span, cursor];
    }
    return [viewT0, viewT1];
    // The trailing window intentionally follows the cursor.
  }, [info, o.windowMode, o.trailing, cursor, viewT0, viewT1]);

  const maxPoints = Math.max(64, Math.round(size.w * 2));
  const { data, error } = useSeries(channels, t0, t1, maxPoints);
  const colors = useMemo(() => colorsFor(channels, o.colorMap), [channels, o.colorMap]);

  // uPlot hooks outlive the render that created them; route anything they read
  // through refs so they never serve values from a stale closure.
  const dataRef = useRef(data);
  dataRef.current = data;
  const colorsRef = useRef(colors);
  colorsRef.current = colors;
  const precisionRef = useRef(o.precision);
  precisionRef.current = o.precision;

  const events = info?.events ?? [];
  const eventsRef = useRef(events);
  eventsRef.current = events;

  // Scale ranges are supplied as callbacks rather than pushed in afterwards
  // with setScale. uPlot asks for the range whenever it needs one, so the plot
  // is never in the state that a declared-but-unset scale leaves it in: the
  // first paint happens before the first query resolves, and an x scale with
  // `auto: false` and no range made uPlot throw out of setSize, which is what
  // left every plot stuck at its initial width.
  const xRangeRef = useRef<[number, number]>([t0, t1]);
  xRangeRef.current = [t0, t1];

  const yRangeRef = useRef<{ mode: string; min?: number; max?: number; full?: [number, number] }>({
    mode: "auto",
  });
  yRangeRef.current = {
    mode: o.yMode ?? "auto",
    min: o.yMin,
    max: o.yMax,
    full:
      o.yMode === "full" && info && !o.normalize
        ? (() => {
            let lo = Infinity;
            let hi = -Infinity;
            for (const name of channels) {
              const meta = info.channels.find((c) => c.name === name);
              if (!meta) continue;
              lo = Math.min(lo, meta.min);
              hi = Math.max(hi, meta.max);
            }
            if (!Number.isFinite(lo) || hi <= lo) return undefined;
            const pad = (hi - lo) * 0.04;
            return [lo - pad, hi + pad] as [number, number];
          })()
        : undefined,
  };

  // uPlot owns its own DOM, so it is resized imperatively rather than through
  // React state. Routing the resize through state made the plot's size depend
  // on effect ordering: the observer can fire before the effect that creates
  // the plot, leaving it stuck at its initial size inside a much wider widget.
  // State is still updated, but only because `maxPoints` is derived from it.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.max(80, Math.floor(e.contentRect.width));
      const h = Math.max(60, Math.floor(e.contentRect.height));
      setSize({ w, h });
      plotRef.current?.setSize({ width: w, height: h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Normalisation ranges, computed from the visible data. */
  const norms = useMemo(() => {
    if (!o.normalize || !data) return null;
    return data.series.map((s) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of s.values) {
        if (v === null) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return hi > lo ? { lo, span: hi - lo } : { lo, span: 1 };
    });
  }, [o.normalize, data]);

  const aligned = useMemo<uPlot.AlignedData | null>(() => {
    if (!data || !data.times.length) return null;
    const ys = data.series.map((s, i) =>
      norms
        ? s.values.map((v) => (v === null ? null : (v - norms[i].lo) / norms[i].span))
        : s.values,
    );
    return [data.times, ...ys] as uPlot.AlignedData;
  }, [data, norms]);

  // Build the plot when its structure changes; data alone flows through setData.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !channels.length) return;

    const drawEvents = (u: uPlot) => {
      const ctx = u.ctx;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const ev of eventsRef.current) {
        const x = u.valToPos(ev.t, "x", true);
        if (x < u.bbox.left - 1 || x > u.bbox.left + u.bbox.width + 1) continue;
        ctx.strokeStyle = ev.kind === "detected" ? CHART.eventDetected : CHART.event;
        ctx.beginPath();
        ctx.moveTo(x, u.bbox.top);
        ctx.lineTo(x, u.bbox.top + u.bbox.height);
        ctx.stroke();
      }
      ctx.restore();
    };

    // Measure at creation rather than trusting state, which may not have caught
    // up with the element's real size yet.
    const rect = el.getBoundingClientRect();
    const initW = Math.max(80, Math.floor(rect.width) || size.w);
    const initH = Math.max(60, Math.floor(rect.height) || size.h);

    const opts: uPlot.Options = {
      width: initW,
      height: initH,
      padding: [10, 12, 0, 0],
      legend: { show: false },
      cursor: {
        y: false,
        drag: { x: false, y: false },
        points: { size: 6, width: 1.5 },
      },
      scales: {
        x: { time: false, range: () => xRangeRef.current },
        y: {
          range: (_u, dataMin, dataMax) => {
            const cfg = yRangeRef.current;
            if (cfg.mode === "manual" && cfg.min !== undefined && cfg.max !== undefined) {
              return [cfg.min, cfg.max];
            }
            if (cfg.full) return cfg.full;
            // No data yet (the first paint precedes the first query), so give
            // uPlot something finite to lay an axis out against.
            if (dataMin == null || dataMax == null) return [0, 1];
            return uPlot.rangeNum(dataMin, dataMax, 0.1, true);
          },
        },
      },
      axes: [
        {
          stroke: CHART.tick,
          grid: { stroke: CHART.grid, width: 1 },
          ticks: { stroke: CHART.axis, width: 1 },
          font: CHART.font,
          size: 26,
          values: (_u, splits) => splits.map((v) => fmtTime(v)),
        },
        {
          stroke: CHART.tick,
          grid: { stroke: CHART.grid, width: 1 },
          ticks: { stroke: CHART.axis, width: 1 },
          font: CHART.font,
          // Measure the widest tick rather than reserving a fixed gutter:
          // channels range from millivolts to hundreds of thousands of pascals,
          // and a fixed width clips the leading digit on the wide ones.
          size: (u, values, axisIdx, cycleNum) => {
            // `_size` is uPlot's internal converged width; it is not in the
            // public typings but is the documented way to stop re-measuring.
            const axis = u.axes[axisIdx] as uPlot.Axis & { _size?: number };
            if (cycleNum > 1) return axis._size ?? 52;
            let width = (axis.ticks?.size ?? 0) + (axis.gap ?? 0);
            const longest = (values ?? []).reduce(
              (acc: string, v: string) => (v.length > acc.length ? v : acc),
              "",
            );
            if (longest !== "") {
              u.ctx.font = (axis.font as unknown as [string, string])[0];
              width += u.ctx.measureText(longest).width / (window.devicePixelRatio || 1);
            }
            return Math.ceil(width) + 8;
          },
          label: o.normalize ? "normalised 0-1" : undefined,
          labelSize: o.normalize ? 16 : 0,
          labelFont: CHART.font,
          values: (_u, splits) => axisValues(splits),
        },
      ],
      series: [
        {},
        ...channels.map((name, i) => ({
          label: name,
          stroke: colors[i],
          width: o.strokeWidth ?? 1.5,
          fill:
            o.fill && channels.length === 1 ? `${colors[i]}22` : undefined,
          spanGaps: false,
          points: { show: false },
        })),
      ],
      hooks: {
        draw: [drawEvents],
        setCursor: [
          (u) => {
            const tip = tooltipRef.current;
            if (!tip) return;
            const idx = u.cursor.idx;
            if (idx === null || idx === undefined || u.cursor.left === undefined || u.cursor.left < 0) {
              tip.style.display = "none";
              return;
            }
            const xs = u.data[0];
            const rows = channels
              .map((name, i) => {
                const raw = dataRef.current?.series[i]?.values[idx];
                return `<div class="tt-row"><span style="width:8px;height:3px;border-radius:2px;background:${colorsRef.current[i]}"></span>${name}<span class="tt-val">${fmt(raw ?? null, precisionRef.current)}</span></div>`;
              })
              .join("");
            tip.innerHTML = `<div class="tt-time">t = ${fmtTime(xs[idx] as number)}</div>${rows}`;
            tip.style.display = "block";
            // Flip the tooltip to the left of the pointer near the right edge
            // so it never spills outside the widget.
            const ratio = pxRatioOf(u);
            const plotLeft = u.bbox.left / ratio;
            const plotWidth = u.bbox.width / ratio;
            const left = plotLeft + u.cursor.left;
            const flip = u.cursor.left > plotWidth * 0.6;
            tip.style.left = `${left + (flip ? -10 : 14)}px`;
            tip.style.transform = flip ? "translateX(-100%)" : "none";
            tip.style.top = `${Math.max(4, (u.cursor.top ?? 0) - 10)}px`;
          },
        ],
      },
    };

    const u = new uPlot(opts, aligned ?? [[], ...channels.map(() => [])] as uPlot.AlignedData, el);
    plotRef.current = u;

    const seek = (e: MouseEvent) => {
      const t = u.posToVal(e.offsetX, "x");
      if (Number.isFinite(t)) setCursor(t);
    };
    u.over.addEventListener("click", seek);
    const hide = () => {
      if (tooltipRef.current) tooltipRef.current.style.display = "none";
    };
    u.over.addEventListener("mouseleave", hide);

    return () => {
      u.over.removeEventListener("click", seek);
      u.over.removeEventListener("mouseleave", hide);
      u.destroy();
      plotRef.current = null;
    };
    // Structural dependencies only — data, colours and precision reach the
    // hooks through refs, so the plot is not torn down on every query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(channels),
    JSON.stringify(colors),
    o.strokeWidth,
    o.fill,
    o.normalize,
    o.yMode,
    o.precision,
    setCursor,
  ]);

  useEffect(() => {
    plotRef.current?.setSize({ width: size.w, height: size.h });
  }, [size.w, size.h]);

  // Event markers live in the canvas draw hook, so a new marker needs a repaint.
  useEffect(() => {
    plotRef.current?.redraw(false, false);
  }, [events.length]);

  useEffect(() => {
    const u = plotRef.current;
    if (!u || !aligned) return;
    // `true` re-evaluates the range callbacks above, which is what moves the
    // window when the timeline is panned or zoomed.
    u.setData(aligned, true);
  }, [aligned, t0, t1, o.yMode, o.yMin, o.yMax, o.normalize]);

  // Reposition the playback cursor without touching the canvas.
  useEffect(() => {
    const u = plotRef.current;
    const line = cursorLineRef.current;
    if (!u || !line) return;
    const inside = cursor >= t0 && cursor <= t1;
    line.style.display = inside ? "block" : "none";
    if (!inside) return;

    // `valToPos` without `canPx` is relative to the plot area, but this line is
    // positioned against the whole chart host — so ask for canvas pixels, which
    // include the axis gutter, and convert back to CSS pixels. Getting this
    // wrong offsets the cursor by the width of the y-axis.
    const ratio = pxRatioOf(u);
    line.style.left = `${u.valToPos(cursor, "x", true) / ratio}px`;
    line.style.top = `${u.bbox.top / ratio}px`;
    line.style.height = `${u.bbox.height / ratio}px`;
  }, [cursor, t0, t1, size, aligned]);

  if (!channels.length) {
    return (
      <div className="empty-hint">
        <div>No channels selected</div>
        <div>Open this widget&rsquo;s settings to choose a data source.</div>
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <div className="chart-host" ref={hostRef} />
        <div
          ref={cursorLineRef}
          style={{
            position: "absolute",
            top: 0,
            width: 1,
            height: 0,
            background: CHART.cursor,
            pointerEvents: "none",
            display: "none",
          }}
        />
        <div ref={tooltipRef} className="u-tooltip" style={{ display: "none" }} />
        {error && (
          <div className="empty-hint" style={{ position: "absolute", inset: 0 }}>
            {error}
          </div>
        )}
      </div>
      {channels.length > 1 && <SeriesLegend channels={channels} colors={colors} precision={o.precision} />}
    </div>
  );
}

/** A legend is mandatory at two or more series so identity is never conveyed by
 *  colour alone; a single series is named by the widget title instead. */
function SeriesLegend({
  channels,
  colors,
  precision,
}: {
  channels: string[];
  colors: string[];
  precision?: number;
}) {
  const samples = useData((s) => s.samples);
  return (
    <div className="legend">
      {channels.map((name, i) => (
        <span className="legend-item" key={name}>
          <span className="legend-swatch" style={{ background: colors[i] }} />
          {name}
          <span className="legend-value">{fmt(samples[name] ?? null, precision)}</span>
        </span>
      ))}
    </div>
  );
}
