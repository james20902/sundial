/**
 * Application state.
 *
 * Three concerns, deliberately separate because they change at wildly
 * different rates: the workspace (tabs and widget layout — edited by hand,
 * persisted), playback (the cursor, which moves every frame), and the loaded
 * dataset. Keeping the cursor out of the persisted store means scrubbing never
 * writes to localStorage.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChannelMeta, DatasetInfo, FlightEvent } from "@/data/types";

export type WidgetKind =
  | "timeseries"
  | "readout"
  | "gauge"
  | "xy"
  | "stats"
  | "events"
  | "attitude";

export interface WidgetOptions {
  // time series
  yMode?: "auto" | "full" | "manual";
  yMin?: number;
  yMax?: number;
  windowMode?: "view" | "trailing" | "full";
  trailing?: number;
  fill?: boolean;
  strokeWidth?: number;
  showLegend?: boolean;
  // readout
  precision?: number;
  showSparkline?: boolean;
  showExtremes?: boolean;
  // gauge
  gMin?: number;
  gMax?: number;
  redline?: number;
  // xy plot
  xChannel?: string;
  equalAxes?: boolean;
  // attitude
  rollCh?: string;
  pitchCh?: string;
  /**
   * Channel name -> palette slot. Persisted so that removing one channel never
   * repaints the ones that remain.
   */
  colorMap?: Record<string, number>;
  /** Scale every series to 0..1 so differently-scaled channels can be compared
   *  by shape. Avoids ever needing a second y-axis. */
  normalize?: boolean;
}

export interface Widget {
  id: string;
  kind: WidgetKind;
  title: string;
  /** Grid placement, in cells. */
  x: number;
  y: number;
  w: number;
  h: number;
  channels: string[];
  options: WidgetOptions;
}

export interface Tab {
  id: string;
  name: string;
  cols: number;
  widgets: Widget[];
}

let seq = 0;
export const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

// --- workspace -------------------------------------------------------------

interface WorkspaceState {
  tabs: Tab[];
  activeTabId: string;
  selectedWidgetId: string | null;
  chatOpen: boolean;
  chatWidth: number;

  setActiveTab: (id: string) => void;
  addTab: (name?: string) => void;
  renameTab: (id: string, name: string) => void;
  removeTab: (id: string) => void;
  duplicateTab: (id: string) => void;

  addWidget: (w: Omit<Widget, "id">) => string;
  updateWidget: (id: string, patch: Partial<Widget>) => void;
  updateOptions: (id: string, patch: WidgetOptions) => void;
  removeWidget: (id: string) => void;
  duplicateWidget: (id: string) => void;
  setLayout: (updates: { id: string; x: number; y: number; w: number; h: number }[]) => void;
  selectWidget: (id: string | null) => void;

  setChatOpen: (open: boolean) => void;
  setChatWidth: (w: number) => void;
  replaceTabs: (tabs: Tab[]) => void;
}

const emptyTab = (name: string): Tab => ({
  id: uid("tab"),
  name,
  cols: 12,
  widgets: [],
});

const firstTab = emptyTab("Flight");

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      tabs: [firstTab],
      activeTabId: firstTab.id,
      selectedWidgetId: null,
      chatOpen: false,
      chatWidth: 380,

      setActiveTab: (id) => set({ activeTabId: id, selectedWidgetId: null }),

      addTab: (name) =>
        set((s) => {
          const t = emptyTab(name ?? `Tab ${s.tabs.length + 1}`);
          return { tabs: [...s.tabs, t], activeTabId: t.id, selectedWidgetId: null };
        }),

      renameTab: (id, name) =>
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t)) })),

      removeTab: (id) =>
        set((s) => {
          if (s.tabs.length === 1) return s; // never leave the workspace tabless
          const tabs = s.tabs.filter((t) => t.id !== id);
          const activeTabId =
            s.activeTabId === id ? tabs[Math.max(0, s.tabs.findIndex((t) => t.id === id) - 1)].id : s.activeTabId;
          return { tabs, activeTabId, selectedWidgetId: null };
        }),

      duplicateTab: (id) =>
        set((s) => {
          const src = s.tabs.find((t) => t.id === id);
          if (!src) return s;
          const copy: Tab = {
            ...src,
            id: uid("tab"),
            name: `${src.name} copy`,
            widgets: src.widgets.map((w) => ({ ...w, id: uid("w") })),
          };
          const i = s.tabs.findIndex((t) => t.id === id);
          const tabs = [...s.tabs];
          tabs.splice(i + 1, 0, copy);
          return { tabs, activeTabId: copy.id };
        }),

      addWidget: (w) => {
        const id = uid("w");
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === s.activeTabId ? { ...t, widgets: [...t.widgets, { ...w, id }] } : t,
          ),
          selectedWidgetId: id,
        }));
        return id;
      },

      updateWidget: (id, patch) =>
        set((s) => ({
          tabs: s.tabs.map((t) => ({
            ...t,
            widgets: t.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)),
          })),
        })),

      updateOptions: (id, patch) =>
        set((s) => ({
          tabs: s.tabs.map((t) => ({
            ...t,
            widgets: t.widgets.map((w) =>
              w.id === id ? { ...w, options: { ...w.options, ...patch } } : w,
            ),
          })),
        })),

      removeWidget: (id) =>
        set((s) => ({
          tabs: s.tabs.map((t) => ({ ...t, widgets: t.widgets.filter((w) => w.id !== id) })),
          selectedWidgetId: s.selectedWidgetId === id ? null : s.selectedWidgetId,
        })),

      duplicateWidget: (id) =>
        set((s) => {
          const tab = s.tabs.find((t) => t.id === s.activeTabId);
          const src = tab?.widgets.find((w) => w.id === id);
          if (!tab || !src) return s;
          const copy: Widget = { ...src, id: uid("w"), y: src.y + src.h };
          return {
            tabs: s.tabs.map((t) =>
              t.id === tab.id ? { ...t, widgets: [...t.widgets, copy] } : t,
            ),
            selectedWidgetId: copy.id,
          };
        }),

      setLayout: (updates) =>
        set((s) => {
          const byId = new Map(updates.map((u) => [u.id, u]));
          return {
            tabs: s.tabs.map((t) =>
              t.id === s.activeTabId
                ? {
                    ...t,
                    widgets: t.widgets.map((w) => {
                      const u = byId.get(w.id);
                      return u ? { ...w, x: u.x, y: u.y, w: u.w, h: u.h } : w;
                    }),
                  }
                : t,
            ),
          };
        }),

      selectWidget: (id) => set({ selectedWidgetId: id }),
      setChatOpen: (chatOpen) => set({ chatOpen }),
      setChatWidth: (chatWidth) => set({ chatWidth: Math.max(300, Math.min(760, chatWidth)) }),
      replaceTabs: (tabs) =>
        set({ tabs, activeTabId: tabs[0]?.id ?? get().activeTabId, selectedWidgetId: null }),
    }),
    {
      name: "sundial.workspace.v1",
      partialize: (s) => ({
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        chatOpen: s.chatOpen,
        chatWidth: s.chatWidth,
      }),
    },
  ),
);

export const useActiveTab = (): Tab => {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  return tabs.find((t) => t.id === activeTabId) ?? tabs[0];
};

// --- playback --------------------------------------------------------------

interface PlaybackState {
  cursor: number;
  playing: boolean;
  speed: number;
  /** Visible time window, which the charts render. */
  viewT0: number;
  viewT1: number;
  /** Keep the cursor pinned to the newest sample of a live feed. */
  follow: boolean;

  setCursor: (t: number) => void;
  setPlaying: (p: boolean) => void;
  togglePlay: () => void;
  setSpeed: (s: number) => void;
  setView: (t0: number, t1: number) => void;
  setFollow: (f: boolean) => void;
}

export const usePlayback = create<PlaybackState>()((set) => ({
  cursor: 0,
  playing: false,
  speed: 1,
  viewT0: 0,
  viewT1: 1,
  follow: true,

  setCursor: (cursor) => set({ cursor }),
  setPlaying: (playing) => set({ playing }),
  togglePlay: () => set((s) => ({ playing: !s.playing })),
  setSpeed: (speed) => set({ speed }),
  setView: (viewT0, viewT1) => set({ viewT0, viewT1 }),
  setFollow: (follow) => set({ follow }),
}));

// --- dataset ---------------------------------------------------------------

interface DataState {
  info: DatasetInfo | null;
  datasets: DatasetInfo[];
  loading: boolean;
  error: string | null;
  notice: string | null;
  /** Values of every demanded channel at the cursor. */
  samples: Record<string, number | null>;
  liveDescription: string | null;
  /** Bumped when the underlying samples change, to invalidate query caches. */
  version: number;

  setInfo: (info: DatasetInfo | null) => void;
  setDatasets: (d: DatasetInfo[]) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  setNotice: (n: string | null) => void;
  setSamples: (s: Record<string, number | null>) => void;
  setEvents: (e: FlightEvent[]) => void;
  setLive: (d: string | null) => void;
  bumpVersion: () => void;
}

export const useData = create<DataState>()((set) => ({
  info: null,
  datasets: [],
  loading: false,
  error: null,
  notice: null,
  samples: {},
  liveDescription: null,
  version: 0,

  setInfo: (info) => set({ info }),
  setDatasets: (datasets) => set({ datasets }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
  setSamples: (samples) => set({ samples }),
  setEvents: (events) =>
    set((s) => ({ info: s.info ? { ...s.info, events } : s.info })),
  setLive: (liveDescription) => set({ liveDescription }),
  bumpVersion: () => set((st) => ({ version: st.version + 1 })),
}));

// --- channel heuristics ----------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Find the first channel whose name matches any of `keys`. */
export function findChannel(channels: ChannelMeta[], keys: string[]): string | undefined {
  for (const k of keys) {
    const exact = channels.find((c) => norm(c.name) === k);
    if (exact) return exact.name;
  }
  for (const k of keys) {
    const partial = channels.find((c) => norm(c.name).includes(k));
    if (partial) return partial.name;
  }
  return undefined;
}

/** All channels sharing a prefix family, e.g. every `gyro_*`. */
export function findGroup(channels: ChannelMeta[], key: string): string[] {
  return channels.filter((c) => norm(c.name).includes(key)).map((c) => c.name);
}

/**
 * Build a starting layout from whatever channels a log actually contains.
 *
 * A fixed default layout would be wrong for every log but the demo, so the
 * first load derives one instead: the flight-profile channels get dedicated
 * plots, sensor families are grouped, and anything left over lands in a stats
 * table so no channel is invisible.
 */
export function buildDefaultTabs(info: DatasetInfo): Tab[] {
  const ch = info.channels;
  const used = new Set<string>();
  const take = (n: string | undefined) => {
    if (n) used.add(n);
    return n;
  };

  const alt = take(findChannel(ch, ["altitude", "alt", "agl", "height", "baroaltitude"]));
  const vel = take(findChannel(ch, ["velocity", "verticalvelocity", "vel", "speed"]));
  const accel = findGroup(ch, "accel").slice(0, 4);
  const gyro = findGroup(ch, "gyro").slice(0, 4);
  const batt = take(findChannel(ch, ["battery", "voltage", "vbat", "batteryvoltage"]));
  accel.forEach((n) => used.add(n));
  gyro.forEach((n) => used.add(n));

  const flight: Tab = { id: uid("tab"), name: "Flight", cols: 12, widgets: [] };
  const sensors: Tab = { id: uid("tab"), name: "Sensors", cols: 12, widgets: [] };

  const add = (tab: Tab, w: Omit<Widget, "id">) => tab.widgets.push({ ...w, id: uid("w") });

  if (alt) {
    add(flight, {
      kind: "timeseries",
      title: "Altitude",
      x: 0,
      y: 0,
      w: 8,
      h: 5,
      channels: [alt],
      options: { yMode: "auto", windowMode: "view", fill: true, showLegend: true },
    });
    add(flight, {
      kind: "readout",
      title: "Altitude",
      x: 8,
      y: 0,
      w: 4,
      h: 2,
      channels: [alt],
      options: { precision: 1, showSparkline: true, showExtremes: true },
    });
  }
  if (vel) {
    add(flight, {
      kind: "timeseries",
      title: "Velocity",
      x: 0,
      y: 5,
      w: 8,
      h: 4,
      channels: [vel],
      options: { yMode: "auto", windowMode: "view", showLegend: true },
    });
    add(flight, {
      kind: "readout",
      title: "Velocity",
      x: 8,
      y: 2,
      w: 4,
      h: 2,
      channels: [vel],
      options: { precision: 1, showSparkline: true, showExtremes: true },
    });
  }
  add(flight, {
    kind: "events",
    title: "Flight events",
    x: 8,
    y: 4,
    w: 4,
    h: 5,
    channels: [],
    options: {},
  });

  if (accel.length) {
    add(sensors, {
      kind: "timeseries",
      title: "Acceleration",
      x: 0,
      y: 0,
      w: 6,
      h: 4,
      channels: accel,
      options: { yMode: "auto", windowMode: "view", showLegend: true },
    });
  }
  if (gyro.length) {
    add(sensors, {
      kind: "timeseries",
      title: "Angular rate",
      x: 6,
      y: 0,
      w: 6,
      h: 4,
      channels: gyro,
      options: { yMode: "auto", windowMode: "view", showLegend: true },
    });
  }
  if (batt) {
    add(sensors, {
      kind: "timeseries",
      title: "Battery",
      x: 0,
      y: 4,
      w: 6,
      h: 4,
      channels: [batt],
      options: { yMode: "auto", windowMode: "view", showLegend: true },
    });
  }

  const rest = ch.map((c) => c.name).filter((n) => !used.has(n));
  add(sensors, {
    kind: "stats",
    title: rest.length ? "Other channels" : "All channels",
    x: 6,
    y: 4,
    w: 6,
    h: 4,
    channels: (rest.length ? rest : ch.map((c) => c.name)).slice(0, 24),
    options: { precision: 3 },
  });

  const tabs = [flight, sensors].filter((t) => t.widgets.length > 0);
  return tabs.length ? tabs : [emptyTab("Flight")];
}
