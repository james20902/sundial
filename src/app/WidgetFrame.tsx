/** Chrome around a widget: draggable title bar, actions, and the body the
 *  registry renders. */

import { useState } from "react";
import { useWorkspace, type Widget } from "@/state/store";
import { widgetDef } from "@/widgets/registry";
import { WidgetConfig } from "./WidgetConfig";

interface Props {
  widget: Widget;
  onHeadPointerDown: (e: React.PointerEvent) => void;
}

export function WidgetFrame({ widget, onHeadPointerDown }: Props) {
  const def = widgetDef(widget.kind);
  const duplicate = useWorkspace((s) => s.duplicateWidget);
  const remove = useWorkspace((s) => s.removeWidget);
  const [configuring, setConfiguring] = useState(false);

  const subtitle =
    def.channelMode === "none"
      ? ""
      : widget.channels.length === 0
        ? "no source"
        : widget.channels.length === 1
          ? widget.channels[0]
          : `${widget.channels.length} channels`;

  return (
    <>
      <div className="widget-head" onPointerDown={onHeadPointerDown}>
        <span className="widget-title">{widget.title || def.label}</span>
        {subtitle && <span className="widget-sub">{subtitle}</span>}
        <span className="spacer" />
        <div className="widget-actions" onPointerDown={(e) => e.stopPropagation()}>
          <button title="Settings" onClick={() => setConfiguring(true)}>
            ⚙
          </button>
          <button title="Duplicate" onClick={() => duplicate(widget.id)}>
            ⧉
          </button>
          <button className="danger" title="Remove" onClick={() => remove(widget.id)}>
            ✕
          </button>
        </div>
      </div>

      <div className="widget-body">{def.render(widget)}</div>

      {configuring && <WidgetConfig widget={widget} onClose={() => setConfiguring(false)} />}
    </>
  );
}
