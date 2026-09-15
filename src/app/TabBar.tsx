/** Window tabs, plus the controls that add things to the active one. */

import { useEffect, useRef, useState } from "react";
import {
  useActiveTab,
  useData,
  useWorkspace,
  buildDefaultTabs,
} from "@/state/store";
import { WIDGETS, widgetDef } from "@/widgets/registry";
import { findSlot } from "@/grid/layout";

export function TabBar() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const setActiveTab = useWorkspace((s) => s.setActiveTab);
  const addTab = useWorkspace((s) => s.addTab);
  const removeTab = useWorkspace((s) => s.removeTab);
  const renameTab = useWorkspace((s) => s.renameTab);
  const duplicateTab = useWorkspace((s) => s.duplicateTab);
  const addWidget = useWorkspace((s) => s.addWidget);
  const replaceTabs = useWorkspace((s) => s.replaceTabs);

  const tab = useActiveTab();
  const info = useData((s) => s.info);
  const [editing, setEditing] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const insert = (kind: (typeof WIDGETS)[number]["kind"]) => {
    const def = widgetDef(kind);
    const { w, h } = def.defaultSize;
    const slot = findSlot(
      tab.widgets.map((x) => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h })),
      tab.cols,
      w,
      h,
    );
    const seeded = info && def.seed ? def.seed(info) : {};
    addWidget({
      kind,
      title: seeded.title ?? def.label,
      x: slot.x,
      y: slot.y,
      w,
      h,
      channels: seeded.channels ?? [],
      options: seeded.options ?? {},
    });
    setMenuOpen(false);
  };

  return (
    <div className="tabbar">
      <div className="tab-strip">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab${t.id === activeTabId ? " active" : ""}`}
            onClick={() => setActiveTab(t.id)}
            onDoubleClick={() => setEditing(t.id)}
            title="Double-click to rename"
          >
            {editing === t.id ? (
              <input
                autoFocus
                defaultValue={t.name}
                onBlur={(e) => {
                  renameTab(t.id, e.target.value.trim() || t.name);
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditing(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span className="tab-name">{t.name}</span>
                <span className="widget-sub">{t.widgets.length}</span>
                {tabs.length > 1 && (
                  <button
                    className="tab-close"
                    title="Close tab"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTab(t.id);
                    }}
                  >
                    ×
                  </button>
                )}
              </>
            )}
          </div>
        ))}

        <button
          className="btn ghost icon"
          style={{ alignSelf: "center", marginLeft: 4 }}
          title="New tab"
          onClick={() => addTab()}
        >
          +
        </button>
      </div>

      <div className="tab-actions" ref={menuRef}>
        <button
          className="btn"
          style={{ alignSelf: "center" }}
          title="Duplicate this tab"
          onClick={() => duplicateTab(activeTabId)}
        >
          ⧉ Duplicate tab
        </button>

        {info && (
          <button
            className="btn"
            style={{ alignSelf: "center" }}
            title="Rebuild tabs from this log's channels, replacing the current layout"
            onClick={() => {
              if (
                window.confirm(
                  "Replace all tabs with a layout generated from this log's channels?",
                )
              ) {
                replaceTabs(buildDefaultTabs(info));
              }
            }}
          >
            ✨ Auto layout
          </button>
        )}

        <button
          className="btn primary"
          style={{ alignSelf: "center" }}
          onClick={() => setMenuOpen((v) => !v)}
        >
          + Add widget
        </button>

        {menuOpen && (
          <div className="menu-pop">
            {WIDGETS.map((d) => (
              <button
                key={d.kind}
                className="menu-item"
                onClick={() => insert(d.kind)}
              >
                <span className="menu-glyph">{d.glyph}</span>
                <span>
                  <div className="menu-label">{d.label}</div>
                  <div className="menu-desc">{d.description}</div>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
