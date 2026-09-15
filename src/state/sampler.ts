/**
 * Cursor sampling.
 *
 * Readouts, gauges and tables all want "the value right now", and the cursor
 * moves every animation frame during playback. Rather than let each widget
 * issue its own round trip, widgets *declare* the channels they need and a
 * single driver fetches the union at most once per frame. One request per
 * frame instead of one per widget per frame is the difference between a
 * dashboard that scrubs smoothly and one that stutters.
 */

import { useEffect } from "react";
import { sampleAt } from "@/data/client";
import { useData, usePlayback } from "./store";

const demand = new Map<string, number>();

/** Declare that this component needs `channels` sampled at the cursor. */
export function useDemandChannels(channels: string[]) {
  const key = JSON.stringify(channels);
  useEffect(() => {
    const list: string[] = JSON.parse(key);
    if (!list.length) return;
    for (const c of list) demand.set(c, (demand.get(c) ?? 0) + 1);
    return () => {
      for (const c of list) {
        const n = (demand.get(c) ?? 1) - 1;
        if (n <= 0) demand.delete(c);
        else demand.set(c, n);
      }
    };
  }, [key]);
}

/**
 * Drive cursor sampling. Mounted once by the app shell.
 *
 * Coalesces on animation frames and never overlaps requests: if the cursor
 * moves again while a fetch is in flight, the newer position simply wins when
 * that fetch returns.
 */
export function useCursorSampler() {
  useEffect(() => {
    let raf = 0;
    let inFlight = false;
    let lastKey = "";
    let stopped = false;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (inFlight || stopped) return;

      const { cursor } = usePlayback.getState();
      const { info, version } = useData.getState();
      if (!info) return;

      const channels = [...demand.keys()];
      if (!channels.length) return;

      // Sub-millisecond cursor moves cannot change a displayed value.
      const key = `${info.id}|${version}|${cursor.toFixed(4)}|${channels.join(",")}`;
      if (key === lastKey) return;
      lastKey = key;

      inFlight = true;
      sampleAt(cursor, channels, info.id)
        .then((values) => {
          if (stopped) return;
          const next: Record<string, number | null> = {};
          channels.forEach((c, i) => (next[c] = values[i] ?? null));
          useData.getState().setSamples(next);
        })
        .catch(() => {
          lastKey = ""; // transient failure; the next frame retries
        })
        .finally(() => {
          inFlight = false;
        });
    };

    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, []);
}

/** Read the cursor value of one channel. */
export function useSampleValue(channel: string | undefined): number | null {
  return useData((s) => (channel ? s.samples[channel] ?? null : null));
}
