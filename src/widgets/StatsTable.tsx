/**
 * Channel table.
 *
 * The tabular view of the same data the charts show — which is also the
 * accessibility fallback for every plot in the workspace, and the fastest way
 * to scan dozens of channels at once.
 */

import { useEffect, useMemo, useState } from "react";
import type { Widget } from "@/state/store";
import { useData, usePlayback } from "@/state/store";
import { useDemandChannels } from "@/state/sampler";
import { channelStats } from "@/data/client";
import type { ChannelStats } from "@/data/types";
import { fmt, fmtTime } from "./chartTheme";

export function StatsTable({ widget }: { widget: Widget }) {
  const channels = widget.channels;
  const info = useData((s) => s.info);
  const samples = useData((s) => s.samples);
  const version = useData((s) => s.version);
  const viewT0 = usePlayback((s) => s.viewT0);
  const viewT1 = usePlayback((s) => s.viewT1);
  const setCursor = usePlayback((s) => s.setCursor);
  const [stats, setStats] = useState<ChannelStats[]>([]);

  useDemandChannels(channels);

  const key = JSON.stringify(channels);
  useEffect(() => {
    const list: string[] = JSON.parse(key);
    if (!info || !list.length) {
      setStats([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      channelStats(list, viewT0, viewT1, info.id)
        .then((s) => !cancelled && setStats(s))
        .catch(() => !cancelled && setStats([]));
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, info, viewT0, viewT1, version]);

  const byName = useMemo(() => new Map(stats.map((s) => [s.name, s])), [stats]);
  const precision = widget.options.precision;

  if (!channels.length) {
    return (
      <div className="empty-hint">
        <div>No channels selected</div>
        <div>Open settings to choose which channels to tabulate.</div>
      </div>
    );
  }

  return (
    <div className="scroll-y">
      <table className="stats-table">
        <thead>
          <tr>
            <th>Channel</th>
            <th>Value</th>
            <th>Min</th>
            <th>Max</th>
            <th>Mean</th>
            <th>SD</th>
          </tr>
        </thead>
        <tbody>
          {channels.map((name) => {
            const s = byName.get(name);
            const unit = s?.unit ?? info?.channels.find((c) => c.name === name)?.unit;
            return (
              <tr key={name}>
                <td title={unit ? `${name} (${unit})` : name}>
                  {name}
                  {unit && <span style={{ color: "var(--text-muted)" }}> {unit}</span>}
                </td>
                <td style={{ color: "var(--text-primary)" }}>
                  {fmt(samples[name] ?? null, precision)}
                </td>
                <td
                  title={s?.tMin != null ? `at ${fmtTime(s.tMin)}` : undefined}
                  onClick={() => s?.tMin != null && setCursor(s.tMin)}
                  style={{ cursor: s?.tMin != null ? "pointer" : undefined }}
                >
                  {fmt(s?.min ?? null, precision)}
                </td>
                <td
                  title={s?.tMax != null ? `at ${fmtTime(s.tMax)}` : undefined}
                  onClick={() => s?.tMax != null && setCursor(s.tMax)}
                  style={{ cursor: s?.tMax != null ? "pointer" : undefined }}
                >
                  {fmt(s?.max ?? null, precision)}
                </td>
                <td>{fmt(s?.mean ?? null, precision)}</td>
                <td>{fmt(s?.stddev ?? null, precision)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
