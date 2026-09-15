/**
 * Categorical series colours.
 *
 * These are the validated dark-surface palette (mirrored as `--series-*` in
 * global.css), assigned in fixed order and never cycled. A widget caps at
 * `MAX_SERIES` channels rather than inventing a ninth hue — past eight, split
 * the widget instead.
 */

export const SERIES_COLORS = [
  "#3987e5", // blue
  "#d95926", // orange
  "#199e70", // aqua
  "#c98500", // yellow
  "#d55181", // magenta
  "#008300", // green
  "#9085e9", // violet
  "#e66767", // red
] as const;

export const MAX_SERIES = SERIES_COLORS.length;

export function slotColor(slot: number): string {
  return SERIES_COLORS[slot % SERIES_COLORS.length];
}

/**
 * Stable channel-to-slot assignment.
 *
 * Colour follows the channel, not its rank: removing one channel must not
 * recolour the others, so existing assignments are preserved and a newly added
 * channel takes the lowest free slot.
 */
export function assignSlots(
  channels: string[],
  existing: Record<string, number> | undefined,
): Record<string, number> {
  const map: Record<string, number> = {};
  const taken = new Set<number>();

  for (const c of channels) {
    const prior = existing?.[c];
    if (prior !== undefined && !taken.has(prior)) {
      map[c] = prior;
      taken.add(prior);
    }
  }
  for (const c of channels) {
    if (map[c] !== undefined) continue;
    let slot = 0;
    while (taken.has(slot)) slot++;
    map[c] = slot;
    taken.add(slot);
  }
  return map;
}

export function colorsFor(
  channels: string[],
  existing: Record<string, number> | undefined,
): string[] {
  const map = assignSlots(channels, existing);
  return channels.map((c) => slotColor(map[c] ?? 0));
}
