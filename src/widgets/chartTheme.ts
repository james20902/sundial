/** Canvas-drawn chart chrome. Mirrors the CSS custom properties, which canvas
 *  cannot read. Recessive by design: grid and axes must never compete with the
 *  data. */
export const CHART = {
  grid: "#242932",
  axis: "#2a303a",
  tick: "#6d7787",
  label: "#8b93a3",
  cursor: "#f0a638",
  event: "rgba(144, 133, 233, 0.55)",
  eventDetected: "rgba(240, 166, 56, 0.6)",
  font: '11px ui-monospace, "SF Mono", Menlo, monospace',
};

/** Round to `precision`, collapsing a negative zero so a tiny noise sample
 *  below zero does not render as "-0.0". */
function fixed(v: number, precision: number): string {
  const r = Number(v.toFixed(precision));
  return (r === 0 ? 0 : r).toFixed(precision);
}

/** Compact axis/readout formatting: telemetry spans many orders of magnitude,
 *  and a fixed precision is wrong for most of them. */
export function fmt(v: number | null | undefined, precision?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (precision !== undefined) return fixed(v, precision);
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1e6 || a < 1e-3) return v.toExponential(2);
  if (a >= 1000) return fixed(v, 0);
  if (a >= 100) return fixed(v, 1);
  if (a >= 1) return fixed(v, 2);
  return fixed(v, 3);
}

/**
 * Format a whole set of axis ticks at one precision.
 *
 * Per-value formatting produces a ladder like "2000 / 1500 / 500.0 / 0", where
 * the decimals jump around mid-axis. The tick spacing is what determines how
 * many decimals are meaningful, so derive the precision once from the spacing
 * and apply it to every label.
 */
export function axisValues(splits: number[]): string[] {
  const finite = splits.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return splits.map(() => "");

  const biggest = Math.max(...finite.map(Math.abs));
  if (biggest >= 1e6 || (biggest > 0 && biggest < 1e-3)) {
    return splits.map((v) => v.toExponential(1));
  }

  let step = Infinity;
  for (let i = 1; i < finite.length; i++) {
    step = Math.min(step, Math.abs(finite[i] - finite[i - 1]));
  }
  if (!Number.isFinite(step) || step <= 0) step = Math.max(biggest, 1e-9);

  // uPlot emits "nice" 1/2/5 x 10^k steps, so the exponent of the step is
  // exactly the number of decimals worth showing.
  const precision = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step) - 1e-9)));
  return splits.map((v) => fixed(v, precision));
}

export function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return "—";
  const sign = t < 0 ? "-" : "";
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return m > 0 ? `${sign}${m}:${s.toFixed(2).padStart(5, "0")}` : `${sign}${s.toFixed(2)}s`;
}
