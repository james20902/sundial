/**
 * Radial gauge.
 *
 * A gauge trades precision for at-a-glance state, so the numeric value is shown
 * alongside the arc rather than replaced by it. The redline is a zone on the
 * scale plus a colour change on the value — never colour alone.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Widget } from "@/state/store";
import { useData } from "@/state/store";
import { useDemandChannels } from "@/state/sampler";
import { colorsFor } from "./colors";
import { fmt } from "./chartTheme";

const START = Math.PI * 0.75;
const SWEEP = Math.PI * 1.5;

export function Gauge({ widget }: { widget: Widget }) {
  const channel = widget.channels[0];
  const o = widget.options;
  const info = useData((s) => s.info);
  const value = useData((s) => (channel ? s.samples[channel] ?? null : null));

  const channels = useMemo(() => (channel ? [channel] : []), [channel]);
  useDemandChannels(channels);

  const hostRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 200, h: 160 });
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
  const min = o.gMin ?? meta?.min ?? 0;
  const max = o.gMax ?? meta?.max ?? 1;
  const color = colorsFor(channels, o.colorMap)[0] ?? "#3987e5";

  if (!channel) {
    return (
      <div className="empty-hint">
        <div>No channel selected</div>
        <div>Open settings to pick a data source.</div>
      </div>
    );
  }

  const size = Math.max(60, Math.min(box.w, box.h * 1.35));
  const cx = box.w / 2;
  const cy = box.h / 2 + size * 0.1;
  const r = size * 0.36;
  const frac = max > min ? Math.min(1, Math.max(0, ((value ?? min) - min) / (max - min))) : 0;
  const over = o.redline !== undefined && value !== null && value >= o.redline;
  const redFrac =
    o.redline !== undefined && max > min
      ? Math.min(1, Math.max(0, (o.redline - min) / (max - min)))
      : null;

  const arc = (from: number, to: number) => {
    const a0 = START + SWEEP * from;
    const a1 = START + SWEEP * to;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${
      cx + r * Math.cos(a1)
    } ${cy + r * Math.sin(a1)}`;
  };

  return (
    <div ref={hostRef} style={{ position: "absolute", inset: 0 }}>
      <svg width={box.w} height={box.h} style={{ display: "block" }}>
        <path d={arc(0, 1)} fill="none" stroke="#242932" strokeWidth={size * 0.07} strokeLinecap="round" />
        {redFrac !== null && redFrac < 1 && (
          <path
            d={arc(redFrac, 1)}
            fill="none"
            stroke="rgba(230, 103, 103, 0.42)"
            strokeWidth={size * 0.07}
            strokeLinecap="round"
          />
        )}
        {frac > 0.001 && (
          <path
            d={arc(0, frac)}
            fill="none"
            stroke={over ? "#e66767" : color}
            strokeWidth={size * 0.07}
            strokeLinecap="round"
          />
        )}
        <text
          x={cx}
          y={cy - size * 0.02}
          textAnchor="middle"
          fill={over ? "#e66767" : "#e6eaf0"}
          style={{
            fontFamily: "var(--mono)",
            fontSize: size * 0.17,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {fmt(value, o.precision ?? 1)}
        </text>
        <text
          x={cx}
          y={cy + size * 0.13}
          textAnchor="middle"
          fill="#6d7787"
          style={{ fontFamily: "var(--mono)", fontSize: size * 0.085 }}
        >
          {meta?.unit ?? channel}
        </text>
        <text
          x={cx - r * 0.82}
          y={cy + r * 0.84}
          textAnchor="middle"
          fill="#6d7787"
          style={{ fontFamily: "var(--mono)", fontSize: size * 0.075 }}
        >
          {fmt(min, 0)}
        </text>
        <text
          x={cx + r * 0.82}
          y={cy + r * 0.84}
          textAnchor="middle"
          fill="#6d7787"
          style={{ fontFamily: "var(--mono)", fontSize: size * 0.075 }}
        >
          {fmt(max, 0)}
        </text>
        {over && (
          <text
            x={cx}
            y={cy + size * 0.3}
            textAnchor="middle"
            fill="#e66767"
            style={{ fontFamily: "var(--sans)", fontSize: size * 0.08, fontWeight: 600 }}
          >
            ▲ OVER {fmt(o.redline, 0)}
          </text>
        )}
      </svg>
    </div>
  );
}
