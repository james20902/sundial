/**
 * XY plot — one channel against another rather than against time.
 *
 * This is how a ground track, a velocity/altitude envelope, or a control
 * response gets read. Only one trajectory is drawn, so no categorical palette
 * is in play; the trail fades toward the past and the current cursor position
 * is marked, which is what makes the direction of travel legible.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Widget } from "@/state/store";
import { useData, usePlayback } from "@/state/store";
import { useSeries } from "./useSeries";
import { colorsFor } from "./colors";
import { CHART, fmt } from "./chartTheme";

export function XYPlot({ widget }: { widget: Widget }) {
  const o = widget.options;
  const xCh = o.xChannel;
  const yCh = widget.channels[0];
  const info = useData((s) => s.info);
  const cursor = usePlayback((s) => s.cursor);
  const viewT0 = usePlayback((s) => s.viewT0);
  const viewT1 = usePlayback((s) => s.viewT1);

  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 260, h: 180 });

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setBox({
        w: Math.max(60, Math.floor(e.contentRect.width)),
        h: Math.max(60, Math.floor(e.contentRect.height)),
      }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const channels = useMemo(
    () => (xCh && yCh ? [xCh, yCh] : []),
    [xCh, yCh],
  );
  const { data } = useSeries(channels, viewT0, viewT1, 2000);
  const color = colorsFor([yCh ?? ""], o.colorMap)[0] ?? "#3987e5";

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !data || data.series.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(box.w * dpr);
    cv.height = Math.round(box.h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);

    const xs = data.series[0].values;
    const ys = data.series[1].values;
    const pad = { l: 46, r: 10, t: 10, b: 24 };
    const w = box.w - pad.l - pad.r;
    const h = box.h - pad.t - pad.b;
    if (w < 10 || h < 10) return;

    let xLo = Infinity;
    let xHi = -Infinity;
    let yLo = Infinity;
    let yHi = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      const y = ys[i];
      if (x === null || y === null) continue;
      if (x < xLo) xLo = x;
      if (x > xHi) xHi = x;
      if (y < yLo) yLo = y;
      if (y > yHi) yHi = y;
    }
    if (!Number.isFinite(xLo) || !Number.isFinite(yLo)) return;

    let xSpan = xHi - xLo || 1;
    let ySpan = yHi - yLo || 1;
    if (o.equalAxes) {
      // Equal aspect matters for a ground track: an unequal one turns a circle
      // into an ellipse and misrepresents the flight path.
      const perX = w / xSpan;
      const perY = h / ySpan;
      const per = Math.min(perX, perY);
      const cxMid = (xLo + xHi) / 2;
      const cyMid = (yLo + yHi) / 2;
      xSpan = w / per;
      ySpan = h / per;
      xLo = cxMid - xSpan / 2;
      yLo = cyMid - ySpan / 2;
    }

    const px = (v: number) => pad.l + ((v - xLo) / xSpan) * w;
    const py = (v: number) => pad.t + h - ((v - yLo) / ySpan) * h;

    ctx.strokeStyle = CHART.axis;
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.l + 0.5, pad.t + 0.5, w, h);

    ctx.font = CHART.font;
    ctx.fillStyle = CHART.tick;
    ctx.textAlign = "right";
    ctx.fillText(fmt(yHi), pad.l - 5, pad.t + 8);
    ctx.fillText(fmt(yLo), pad.l - 5, pad.t + h);
    ctx.textAlign = "left";
    ctx.fillText(fmt(xLo), pad.l, box.h - 8);
    ctx.textAlign = "right";
    ctx.fillText(fmt(xHi), pad.l + w, box.h - 8);
    ctx.textAlign = "center";
    ctx.fillStyle = CHART.label;
    ctx.fillText(`${xCh} →`, pad.l + w / 2, box.h - 8);

    // Draw the trail in two passes so the recent segment reads as "now".
    const cutoff = data.times.findIndex((t) => t >= cursor);
    const end = cutoff < 0 ? xs.length : cutoff;

    ctx.lineJoin = "round";
    ctx.strokeStyle = `${color}55`;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      const y = ys[i];
      if (x === null || y === null) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(px(x), py(y));
        started = true;
      } else ctx.lineTo(px(x), py(y));
    }
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    started = false;
    const trailStart = Math.max(0, end - (o.trailing ? Math.round(o.trailing * 50) : xs.length));
    for (let i = trailStart; i < end; i++) {
      const x = xs[i];
      const y = ys[i];
      if (x === null || y === null) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(px(x), py(y));
        started = true;
      } else ctx.lineTo(px(x), py(y));
    }
    ctx.stroke();

    const ix = Math.min(Math.max(0, end - 1), xs.length - 1);
    const cxv = xs[ix];
    const cyv = ys[ix];
    if (cxv !== null && cyv !== null && cxv !== undefined && cyv !== undefined) {
      ctx.beginPath();
      ctx.arc(px(cxv), py(cyv), 4.5, 0, Math.PI * 2);
      ctx.fillStyle = CHART.cursor;
      ctx.fill();
      // A surface-coloured ring keeps the marker legible over the trail.
      ctx.strokeStyle = "#171a1f";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [data, box, color, cursor, o.equalAxes, o.trailing, xCh]);

  if (!xCh || !yCh) {
    return (
      <div className="empty-hint">
        <div>XY plot needs two channels</div>
        <div>Pick a Y channel and an X channel in settings.</div>
      </div>
    );
  }

  const yMeta = info?.channels.find((c) => c.name === yCh);

  return (
    <div ref={hostRef} style={{ position: "absolute", inset: 0 }}>
      <canvas ref={canvasRef} style={{ width: box.w, height: box.h, display: "block" }} />
      <div
        style={{
          position: "absolute",
          top: 6,
          left: 52,
          fontSize: 10,
          color: CHART.label,
          fontFamily: "var(--mono)",
          pointerEvents: "none",
        }}
      >
        {yCh}
        {yMeta?.unit ? ` (${yMeta.unit})` : ""} ↑
      </div>
    </div>
  );
}
