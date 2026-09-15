/**
 * Attitude indicator.
 *
 * Reads a roll and a pitch channel and draws the familiar artificial horizon.
 * Numeric roll/pitch are printed alongside because the instrument is for
 * orientation at a glance, not for reading exact values off the ball.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Widget } from "@/state/store";
import { useData } from "@/state/store";
import { useDemandChannels } from "@/state/sampler";
import { fmt } from "./chartTheme";

export function Attitude({ widget }: { widget: Widget }) {
  const o = widget.options;
  const rollCh = o.rollCh;
  const pitchCh = o.pitchCh;
  const samples = useData((s) => s.samples);

  const channels = useMemo(
    () => [rollCh, pitchCh].filter(Boolean) as string[],
    [rollCh, pitchCh],
  );
  useDemandChannels(channels);

  const hostRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 200, h: 180 });
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setBox({ w: e.contentRect.width, h: e.contentRect.height }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!rollCh || !pitchCh) {
    return (
      <div className="empty-hint">
        <div>Attitude needs a roll and a pitch channel</div>
        <div>Assign them in settings.</div>
      </div>
    );
  }

  const roll = samples[rollCh] ?? 0;
  const pitch = samples[pitchCh] ?? 0;
  const size = Math.max(50, Math.min(box.w, box.h) * 0.86);
  const cx = box.w / 2;
  const cy = box.h / 2;
  const r = size / 2;
  // Degrees of pitch per pixel of horizon travel, matching a typical ADI.
  const pxPerDeg = r / 45;
  const offset = Math.max(-r * 1.6, Math.min(r * 1.6, pitch * pxPerDeg));

  return (
    <div ref={hostRef} style={{ position: "absolute", inset: 0 }}>
      <svg width={box.w} height={box.h} style={{ display: "block" }}>
        <defs>
          <clipPath id={`adi-${widget.id}`}>
            <circle cx={cx} cy={cy} r={r} />
          </clipPath>
        </defs>

        <g clipPath={`url(#adi-${widget.id})`}>
          <g transform={`rotate(${-roll} ${cx} ${cy}) translate(0 ${offset})`}>
            <rect x={cx - r * 2} y={cy - r * 4} width={r * 4} height={r * 4} fill="#2c4a6b" />
            <rect x={cx - r * 2} y={cy} width={r * 4} height={r * 4} fill="#5a4326" />
            <line
              x1={cx - r * 2}
              y1={cy}
              x2={cx + r * 2}
              y2={cy}
              stroke="#e6eaf0"
              strokeWidth={1.5}
            />
            {[-30, -20, -10, 10, 20, 30].map((d) => (
              <g key={d}>
                <line
                  x1={cx - r * 0.22}
                  y1={cy - d * pxPerDeg}
                  x2={cx + r * 0.22}
                  y2={cy - d * pxPerDeg}
                  stroke="rgba(230,234,240,0.7)"
                  strokeWidth={1}
                />
                <text
                  x={cx - r * 0.3}
                  y={cy - d * pxPerDeg + 3}
                  textAnchor="end"
                  fill="rgba(230,234,240,0.7)"
                  style={{ fontFamily: "var(--mono)", fontSize: r * 0.1 }}
                >
                  {Math.abs(d)}
                </text>
              </g>
            ))}
          </g>
        </g>

        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#2a303a" strokeWidth={2} />

        {/* Fixed aircraft reference */}
        <path
          d={`M ${cx - r * 0.42} ${cy} h ${r * 0.22} l ${r * 0.1} ${r * 0.09} l ${r * 0.1} ${-r * 0.09} h ${r * 0.22}`}
          fill="none"
          stroke="#f0a638"
          strokeWidth={2.2}
          strokeLinejoin="round"
        />
        <circle cx={cx} cy={cy} r={2} fill="#f0a638" />

        {/* Roll pointer */}
        <g transform={`rotate(${-roll} ${cx} ${cy})`}>
          <path
            d={`M ${cx} ${cy - r + 2} l ${-r * 0.06} ${r * 0.11} l ${r * 0.12} 0 z`}
            fill="#f0a638"
          />
        </g>

        <text
          x={8}
          y={box.h - 8}
          fill="#a4adbd"
          style={{ fontFamily: "var(--mono)", fontSize: 11 }}
        >
          R {fmt(roll, 1)}°
        </text>
        <text
          x={box.w - 8}
          y={box.h - 8}
          textAnchor="end"
          fill="#a4adbd"
          style={{ fontFamily: "var(--mono)", fontSize: 11 }}
        >
          P {fmt(pitch, 1)}°
        </text>
      </svg>
    </div>
  );
}
