/**
 * Range-query hook shared by every plotting widget.
 *
 * Requests are debounced so that dragging the timeline does not fire one query
 * per pointer event, and identical in-flight requests are shared — several
 * widgets showing the same window and channels cost one round trip, not one
 * each.
 */

import { useEffect, useRef, useState } from "react";
import { queryRange } from "@/data/client";
import { useData } from "@/state/store";
import type { RangeQuery } from "@/data/types";

const inFlight = new Map<string, Promise<RangeQuery>>();

function sharedQuery(
  key: string,
  channels: string[],
  t0: number,
  t1: number,
  maxPoints: number,
  id: string,
): Promise<RangeQuery> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = queryRange(channels, t0, t1, maxPoints, id).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

export interface SeriesResult {
  data: RangeQuery | null;
  loading: boolean;
  error: string | null;
}

export function useSeries(
  channels: string[],
  t0: number,
  t1: number,
  maxPoints: number,
): SeriesResult {
  const info = useData((s) => s.info);
  const version = useData((s) => s.version);
  const [result, setResult] = useState<SeriesResult>({
    data: null,
    loading: false,
    error: null,
  });
  // Guards against an earlier, slower response overwriting a newer one.
  const gen = useRef(0);

  const channelKey = JSON.stringify(channels);
  const datasetId = info?.id ?? "";

  useEffect(() => {
    const list: string[] = JSON.parse(channelKey);
    if (!datasetId || !list.length || !(t1 > t0)) {
      setResult({ data: null, loading: false, error: null });
      return;
    }

    const mine = ++gen.current;
    setResult((r) => ({ ...r, loading: true }));

    // Quantising the window keeps the shared-request key from missing on
    // floating-point noise while a drag is settling.
    const key = [
      datasetId,
      version,
      channelKey,
      t0.toFixed(4),
      t1.toFixed(4),
      maxPoints,
    ].join("|");

    const timer = setTimeout(() => {
      sharedQuery(key, list, t0, t1, maxPoints, datasetId)
        .then((data) => {
          if (gen.current !== mine) return;
          setResult({ data, loading: false, error: null });
        })
        .catch((e: unknown) => {
          if (gen.current !== mine) return;
          setResult({ data: null, loading: false, error: String(e) });
        });
    }, 40);

    return () => clearTimeout(timer);
  }, [datasetId, version, channelKey, t0, t1, maxPoints]);

  return result;
}
