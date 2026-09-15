/**
 * Per-widget settings sheet.
 *
 * Every widget gets a data source and a title; the rest of the controls are
 * whatever that widget kind can actually act on, so the panel never shows a
 * dead option.
 */

import { useData, useWorkspace, type Widget } from "@/state/store";
import { widgetDef } from "@/widgets/registry";
import { ChannelPicker } from "./ChannelPicker";

export function WidgetConfig({ widget, onClose }: { widget: Widget; onClose: () => void }) {
  const update = useWorkspace((s) => s.updateWidget);
  const updateOptions = useWorkspace((s) => s.updateOptions);
  const remove = useWorkspace((s) => s.removeWidget);
  const info = useData((s) => s.info);
  const def = widgetDef(widget.kind);
  const o = widget.options;

  const setOpt = (patch: Partial<typeof o>) => updateOptions(widget.id, patch);

  return (
    <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet wide">
        <div className="sheet-head">
          <span>{def.glyph}</span>
          <span>{def.label} settings</span>
          <span className="spacer" />
          <button className="btn ghost icon" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="sheet-body">
          <div className="field">
            <label>Title</label>
            <input
              value={widget.title}
              placeholder={def.label}
              onChange={(e) => update(widget.id, { title: e.target.value })}
            />
          </div>

          <div className="field">
            <label>Visualization</label>
            <select
              value={widget.kind}
              onChange={(e) => {
                const kind = e.target.value as Widget["kind"];
                const next = widgetDef(kind);
                // Carry channels across where they still make sense; drop them
                // when the new kind cannot use that many.
                const channels =
                  next.channelMode === "none"
                    ? []
                    : next.channelMode === "one"
                      ? widget.channels.slice(0, 1)
                      : widget.channels;
                update(widget.id, { kind, channels });
              }}
            >
              {[
                "timeseries",
                "readout",
                "gauge",
                "xy",
                "stats",
                "events",
                "attitude",
              ].map((k) => (
                <option key={k} value={k}>
                  {widgetDef(k as Widget["kind"]).label}
                </option>
              ))}
            </select>
            <div className="hint">{def.description}</div>
          </div>

          {def.channelMode !== "none" && (
            <ChannelPicker
              mode={def.channelMode}
              selected={widget.channels}
              colorMap={o.colorMap}
              onChange={(channels, colorMap) => {
                update(widget.id, { channels });
                setOpt({ colorMap });
              }}
            />
          )}

          {widget.kind === "timeseries" && (
            <>
              <div className="field-row">
                <div className="field">
                  <label>Time window</label>
                  <select
                    value={o.windowMode ?? "view"}
                    onChange={(e) => setOpt({ windowMode: e.target.value as never })}
                  >
                    <option value="view">Follow the timeline view</option>
                    <option value="trailing">Trailing window from cursor</option>
                    <option value="full">Whole flight</option>
                  </select>
                </div>
                {o.windowMode === "trailing" && (
                  <div className="field" style={{ maxWidth: 120 }}>
                    <label>Seconds</label>
                    <input
                      type="number"
                      min={0.1}
                      step={0.5}
                      value={o.trailing ?? 10}
                      onChange={(e) => setOpt({ trailing: Number(e.target.value) })}
                    />
                  </div>
                )}
              </div>

              <div className="field-row">
                <div className="field">
                  <label>Y axis</label>
                  <select
                    value={o.yMode ?? "auto"}
                    onChange={(e) => setOpt({ yMode: e.target.value as never })}
                  >
                    <option value="auto">Auto-fit visible data</option>
                    <option value="full">Channel's full range</option>
                    <option value="manual">Manual</option>
                  </select>
                </div>
                {o.yMode === "manual" && (
                  <>
                    <div className="field" style={{ maxWidth: 110 }}>
                      <label>Min</label>
                      <input
                        type="number"
                        value={o.yMin ?? 0}
                        onChange={(e) => setOpt({ yMin: Number(e.target.value) })}
                      />
                    </div>
                    <div className="field" style={{ maxWidth: 110 }}>
                      <label>Max</label>
                      <input
                        type="number"
                        value={o.yMax ?? 1}
                        onChange={(e) => setOpt({ yMax: Number(e.target.value) })}
                      />
                    </div>
                  </>
                )}
              </div>

              <div className="field-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!o.normalize}
                    onChange={(e) => setOpt({ normalize: e.target.checked })}
                  />
                  Normalise each series to 0–1
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={o.fill !== false}
                    onChange={(e) => setOpt({ fill: e.target.checked })}
                  />
                  Fill under line (single channel)
                </label>
              </div>
              {o.normalize && (
                <div className="hint">
                  Channels of very different magnitude are compared by shape. Sundial has no
                  second y-axis on purpose — two scales on one plot make unrelated series look
                  correlated.
                </div>
              )}

              <div className="field" style={{ maxWidth: 160 }}>
                <label>Line width</label>
                <input
                  type="number"
                  min={0.5}
                  max={4}
                  step={0.5}
                  value={o.strokeWidth ?? 1.5}
                  onChange={(e) => setOpt({ strokeWidth: Number(e.target.value) })}
                />
              </div>
            </>
          )}

          {widget.kind === "readout" && (
            <div className="field-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={o.showSparkline !== false}
                  onChange={(e) => setOpt({ showSparkline: e.target.checked })}
                />
                Sparkline
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={o.showExtremes !== false}
                  onChange={(e) => setOpt({ showExtremes: e.target.checked })}
                />
                Min / max over view
              </label>
            </div>
          )}

          {widget.kind === "gauge" && (
            <div className="field-row">
              <div className="field">
                <label>Scale min</label>
                <input
                  type="number"
                  value={o.gMin ?? 0}
                  onChange={(e) => setOpt({ gMin: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>Scale max</label>
                <input
                  type="number"
                  value={o.gMax ?? 100}
                  onChange={(e) => setOpt({ gMax: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>Redline</label>
                <input
                  type="number"
                  placeholder="none"
                  value={o.redline ?? ""}
                  onChange={(e) =>
                    setOpt({ redline: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              </div>
            </div>
          )}

          {widget.kind === "xy" && (
            <>
              <div className="field">
                <label>X axis channel</label>
                <select
                  value={o.xChannel ?? ""}
                  onChange={(e) => setOpt({ xChannel: e.target.value || undefined })}
                >
                  <option value="">— select —</option>
                  {(info?.channels ?? []).map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                      {c.unit ? ` (${c.unit})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!o.equalAxes}
                  onChange={(e) => setOpt({ equalAxes: e.target.checked })}
                />
                Equal axis scaling (use for ground tracks)
              </label>
            </>
          )}

          {widget.kind === "attitude" && (
            <div className="field-row">
              <div className="field">
                <label>Roll channel</label>
                <select
                  value={o.rollCh ?? ""}
                  onChange={(e) => setOpt({ rollCh: e.target.value || undefined })}
                >
                  <option value="">— select —</option>
                  {(info?.channels ?? []).map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Pitch channel</label>
                <select
                  value={o.pitchCh ?? ""}
                  onChange={(e) => setOpt({ pitchCh: e.target.value || undefined })}
                >
                  <option value="">— select —</option>
                  {(info?.channels ?? []).map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {widget.kind !== "events" && widget.kind !== "attitude" && (
            <div className="field" style={{ maxWidth: 180 }}>
              <label>Decimal places</label>
              <input
                type="number"
                min={0}
                max={8}
                placeholder="auto"
                value={o.precision ?? ""}
                onChange={(e) =>
                  setOpt({ precision: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              />
            </div>
          )}
        </div>

        <div className="sheet-foot">
          <button
            className="btn"
            style={{ marginRight: "auto", color: "var(--danger)" }}
            onClick={() => {
              remove(widget.id);
              onClose();
            }}
          >
            Delete widget
          </button>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
