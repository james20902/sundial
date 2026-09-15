/** Grid geometry and collision resolution for the widget canvas. */

export interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_W = 2;
export const MIN_H = 2;

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function clamp(r: Rect, cols: number): Rect {
  const w = Math.max(MIN_W, Math.min(cols, r.w));
  const h = Math.max(MIN_H, r.h);
  return {
    ...r,
    w,
    h,
    x: Math.max(0, Math.min(cols - w, r.x)),
    y: Math.max(0, r.y),
  };
}

/**
 * Settle the layout after `anchorId` has been moved or resized.
 *
 * The anchor keeps exactly the position the operator dropped it in — a layout
 * that shuffles the thing you are dragging is maddening — and everything else
 * is pushed straight down out of its way. Downward-only displacement keeps the
 * result predictable: widgets never dart sideways or swap places.
 */
export function resolve(items: Rect[], anchorId: string | null, cols: number): Rect[] {
  const anchor = items.find((i) => i.id === anchorId);
  const rest = items
    .filter((i) => i.id !== anchorId)
    // Settle in reading order so upper widgets claim their space first.
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const placed: Rect[] = [];
  if (anchor) placed.push(clamp(anchor, cols));

  for (const item of rest) {
    const r = clamp({ ...item }, cols);
    let guard = 0;
    while (placed.some((p) => overlaps(r, p))) {
      const blocker = placed.filter((p) => overlaps(r, p)).sort((a, b) => b.y + b.h - (a.y + a.h))[0];
      r.y = blocker.y + blocker.h;
      if (++guard > 500) break; // pathological layout; stop rather than hang
    }
    placed.push(r);
  }

  return placed;
}

/** Pack everything upward, closing vertical gaps left by deletions. */
export function compact(items: Rect[], cols: number): Rect[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: Rect[] = [];
  for (const item of sorted) {
    const r = clamp({ ...item }, cols);
    while (r.y > 0) {
      const up = { ...r, y: r.y - 1 };
      if (placed.some((p) => overlaps(up, p))) break;
      r.y = up.y;
    }
    placed.push(r);
  }
  return placed;
}

/** First free slot that fits a `w`×`h` widget, scanning in reading order. */
export function findSlot(items: Rect[], cols: number, w: number, h: number): { x: number; y: number } {
  const maxY = items.reduce((m, i) => Math.max(m, i.y + i.h), 0);
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const probe: Rect = { id: "__probe", x, y, w, h };
      if (!items.some((i) => overlaps(probe, i))) return { x, y };
    }
  }
  return { x: 0, y: maxY };
}

export function bottomRow(items: Rect[]): number {
  return items.reduce((m, i) => Math.max(m, i.y + i.h), 0);
}
