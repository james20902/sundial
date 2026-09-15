/**
 * Channel selector.
 *
 * Flight logs routinely carry fifty-plus channels, so this is search-first.
 * Selected channels show their assigned palette colour, which is what makes the
 * link between this list and a plot's lines obvious.
 */

import { useMemo, useState } from "react";
import { useData } from "@/state/store";
import { assignSlots, MAX_SERIES, slotColor } from "@/widgets/colors";
import { fmt } from "@/widgets/chartTheme";

interface Props {
  selected: string[];
  onChange: (channels: string[], colorMap: Record<string, number>) => void;
  colorMap?: Record<string, number>;
  /** `one` replaces the selection; `many` toggles. */
  mode: "one" | "many";
  max?: number;
}

export function ChannelPicker({ selected, onChange, colorMap, mode, max }: Props) {
  const info = useData((s) => s.info);
  const [q, setQ] = useState("");

  const channels = info?.channels ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return channels;
    return channels.filter((c) => c.name.toLowerCase().includes(needle));
  }, [channels, q]);

  const slots = assignSlots(selected, colorMap);
  const cap = max ?? (mode === "one" ? 1 : MAX_SERIES);
  const atCap = selected.length >= cap;

  const toggle = (name: string) => {
    let next: string[];
    if (mode === "one") {
      next = [name];
    } else if (selected.includes(name)) {
      next = selected.filter((c) => c !== name);
    } else if (atCap) {
      return;
    } else {
      next = [...selected, name];
    }
    onChange(next, assignSlots(next, colorMap));
  };

  if (!info) {
    return <div className="hint">Load a flight log to choose channels.</div>;
  }

  return (
    <div className="field">
      <label>Data source{mode === "many" ? ` — ${selected.length}/${cap} channels` : ""}</label>

      {selected.length > 0 && (
        <div className="chips">
          {selected.map((name) => (
            <span className="chip" key={name}>
              <span
                className="picker-swatch"
                style={{ background: slotColor(slots[name] ?? 0), width: 8, height: 8 }}
              />
              {name}
              <button onClick={() => toggle(name)} title="Remove">
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        placeholder={`Search ${channels.length} channels…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />

      <div className="picker-list">
        {filtered.length === 0 && <div className="hint" style={{ padding: 10 }}>No matches.</div>}
        {filtered.map((c) => {
          const on = selected.includes(c.name);
          const blocked = !on && atCap && mode === "many";
          return (
            <div
              key={c.name}
              className={`picker-row${on ? " on" : ""}`}
              style={blocked ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
              onClick={() => !blocked && toggle(c.name)}
              title={blocked ? `Remove a channel first — ${cap} is the maximum` : undefined}
            >
              <span
                className="picker-swatch"
                style={{
                  background: on ? slotColor(slots[c.name] ?? 0) : "transparent",
                  borderColor: on ? "transparent" : "var(--border-strong)",
                }}
              />
              <span className="picker-name">{c.name}</span>
              <span className="picker-meta">
                {c.unit ? `${c.unit} · ` : ""}
                {fmt(c.min)} … {fmt(c.max)}
              </span>
            </div>
          );
        })}
      </div>

      {atCap && mode === "many" && (
        <div className="hint">
          Eight is the cap — the categorical palette has eight validated hues and a ninth
          would be indistinguishable. Split the extra channels into a second widget.
        </div>
      )}
    </div>
  );
}
