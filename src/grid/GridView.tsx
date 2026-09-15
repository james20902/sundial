/**
 * The widget canvas: a snap-to-cell grid that widgets are dragged and resized
 * within.
 *
 * Pixel positions are derived from cell coordinates every render, so the layout
 * reflows when the window or chat panel resizes without any stored pixel values
 * going stale. During a drag the widget follows the pointer freely while a
 * placeholder shows the cell it will land in — dragging against a hard snap
 * feels sticky, and the placeholder keeps the outcome unambiguous.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useActiveTab, useWorkspace, type Widget } from "@/state/store";
import { WidgetFrame } from "@/app/WidgetFrame";
import { bottomRow, clamp, resolve, type Rect } from "./layout";

const ROW_H = 42;
const GAP = 8;
const PAD = 10;

type DragMode = "move" | "e" | "s" | "se";

interface DragState {
  id: string;
  mode: DragMode;
  startX: number;
  startY: number;
  origin: Rect;
  /** Live pixel offset, for the free-following visual. */
  dx: number;
  dy: number;
}

export function GridView() {
  const tab = useActiveTab();
  const setLayout = useWorkspace((s) => s.setLayout);
  const selectWidget = useWorkspace((s) => s.selectWidget);
  const selectedId = useWorkspace((s) => s.selectedWidgetId);

  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const cols = tab?.cols ?? 12;
  const cellW = Math.max(24, (width - PAD * 2 - GAP * (cols - 1)) / cols);

  const toPx = useCallback(
    (r: { x: number; y: number; w: number; h: number }) => ({
      left: PAD + r.x * (cellW + GAP),
      top: PAD + r.y * (ROW_H + GAP),
      width: r.w * cellW + (r.w - 1) * GAP,
      height: r.h * ROW_H + (r.h - 1) * GAP,
    }),
    [cellW],
  );

  /** Cell rect the current drag would commit to. */
  const draftRect = useCallback(
    (d: DragState): Rect => {
      const dxCells = Math.round(d.dx / (cellW + GAP));
      const dyCells = Math.round(d.dy / (ROW_H + GAP));
      const o = d.origin;
      const next: Rect =
        d.mode === "move"
          ? { ...o, x: o.x + dxCells, y: o.y + dyCells }
          : {
              ...o,
              w: d.mode === "s" ? o.w : o.w + dxCells,
              h: d.mode === "e" ? o.h : o.h + dyCells,
            };
      return clamp(next, cols);
    },
    [cellW, cols],
  );

  const beginDrag = useCallback(
    (e: React.PointerEvent, widget: Widget, mode: DragMode) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      selectWidget(widget.id);
      setDrag({
        id: widget.id,
        mode,
        startX: e.clientX,
        startY: e.clientY,
        origin: { id: widget.id, x: widget.x, y: widget.y, w: widget.w, h: widget.h },
        dx: 0,
        dy: 0,
      });
    },
    [selectWidget],
  );

  useEffect(() => {
    if (!drag) return;

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setDrag({ ...d, dx: e.clientX - d.startX, dy: e.clientY - d.startY });
    };

    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d || !tab) return;
      const target = draftRect(d);
      if (
        target.x === d.origin.x &&
        target.y === d.origin.y &&
        target.w === d.origin.w &&
        target.h === d.origin.h
      ) {
        return; // a click, not a drag
      }
      const rects: Rect[] = tab.widgets.map((w) =>
        w.id === d.id ? target : { id: w.id, x: w.x, y: w.y, w: w.w, h: w.h },
      );
      setLayout(resolve(rects, d.id, cols));
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, tab, cols, draftRect, setLayout]);

  if (!tab) return null;

  const rows = Math.max(bottomRow(tab.widgets) + 2, 12);
  const canvasHeight = PAD * 2 + rows * ROW_H + (rows - 1) * GAP;
  const placeholder = drag ? draftRect(drag) : null;

  return (
    <div
      className="grid-scroll"
      ref={hostRef}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvas) {
          selectWidget(null);
        }
      }}
    >
      <div
        className={`grid-canvas${drag ? " dragging" : ""}`}
        data-canvas="1"
        style={{ height: canvasHeight }}
      >
        <div
          className="grid-guides"
          style={{
            backgroundImage: `linear-gradient(90deg, var(--border) 1px, transparent 1px), linear-gradient(var(--border) 1px, transparent 1px)`,
            backgroundSize: `${cellW + GAP}px ${ROW_H + GAP}px`,
            backgroundPosition: `${PAD}px ${PAD}px`,
          }}
        />

        {placeholder && <div className="grid-placeholder" style={toPx(placeholder)} />}

        {tab.widgets.map((w) => {
          const active = drag?.id === w.id;
          const box = toPx(w);
          const style: React.CSSProperties = active
            ? drag.mode === "move"
              ? { ...box, transform: `translate(${drag.dx}px, ${drag.dy}px)` }
              : {
                  ...box,
                  width: Math.max(
                    cellW,
                    box.width + (drag.mode === "s" ? 0 : drag.dx),
                  ),
                  height: Math.max(ROW_H, box.height + (drag.mode === "e" ? 0 : drag.dy)),
                }
            : box;

          return (
            <div
              key={w.id}
              className={`widget${selectedId === w.id ? " selected" : ""}${active ? " moving" : ""}`}
              style={style}
              onPointerDown={() => selectWidget(w.id)}
            >
              <WidgetFrame
                widget={w}
                onHeadPointerDown={(e) => beginDrag(e, w, "move")}
              />
              <div className="resize-handle e" onPointerDown={(e) => beginDrag(e, w, "e")} />
              <div className="resize-handle s" onPointerDown={(e) => beginDrag(e, w, "s")} />
              <div className="resize-handle se" onPointerDown={(e) => beginDrag(e, w, "se")} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
