/**
 * Application shell.
 *
 * Owns the things that must exist exactly once: the playback clock, the cursor
 * sampler, keyboard transport, and the live-feed subscription.
 */

import { useEffect } from "react";
import {
  EV_LIVE_ENDED,
  EV_LIVE_FRAMES,
  datasetInfo,
  listDatasets,
  listen,
  addMarker,
} from "@/data/client";
import type { LiveEnded, LiveTick } from "@/data/types";
import {
  buildDefaultTabs,
  useData,
  usePlayback,
  useWorkspace,
} from "@/state/store";
import { useCursorSampler } from "@/state/sampler";
import { GridView } from "@/grid/GridView";
import { fmtTime } from "@/widgets/chartTheme";
import { SourceBar } from "./SourceBar";
import { TabBar } from "./TabBar";
import { Timeline } from "./Timeline";
import { ChatPanel } from "./ChatPanel";

export function App() {
  const info = useData((s) => s.info);
  const error = useData((s) => s.error);
  const notice = useData((s) => s.notice);
  const chatOpen = useWorkspace((s) => s.chatOpen);

  useCursorSampler();
  useInitialLoad();
  usePlaybackClock();
  useLiveFeed();
  useTransportKeys();

  return (
    <div className="app">
      <SourceBar />
      <TabBar />
      {info ? <GridView /> : <NoLog />}
      <Timeline />
      {chatOpen && <ChatPanel />}
      {(error || notice) && <Toast />}
    </div>
  );
}

function NoLog() {
  return (
    <div className="grid-scroll">
      <div className="empty-hint" style={{ height: "60vh" }}>
        <div style={{ fontSize: 15, color: "var(--text-secondary)" }}>No flight log loaded</div>
        <div>Open a CSV, TSV or JSONL log to start scrubbing.</div>
      </div>
    </div>
  );
}

function Toast() {
  const error = useData((s) => s.error);
  const notice = useData((s) => s.notice);
  const setError = useData((s) => s.setError);
  const setNotice = useData((s) => s.setNotice);
  const isError = !!error;

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 9000);
    return () => clearTimeout(t);
  }, [notice, setNotice]);

  return (
    <div className={`toast${isError ? " error" : ""}`}>
      <span className="selectable">{error ?? notice}</span>
      <button
        className="btn ghost icon"
        onClick={() => (isError ? setError(null) : setNotice(null))}
      >
        ✕
      </button>
    </div>
  );
}

/** Load whatever the backend already has, and seed a layout on first run. */
function useInitialLoad() {
  const setInfo = useData((s) => s.setInfo);
  const setDatasets = useData((s) => s.setDatasets);
  const setView = usePlayback((s) => s.setView);
  const setCursor = usePlayback((s) => s.setCursor);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [current, all] = await Promise.all([datasetInfo(), listDatasets()]);
        if (cancelled || !current) return;
        setInfo(current);
        setDatasets(all);
        setView(current.t0, current.t1);
        setCursor(current.t0);

        // A default layout cannot be written ahead of time — it depends on the
        // channels this particular log carries — so derive one the first time
        // a log is opened into an empty workspace.
        const ws = useWorkspace.getState();
        if (ws.tabs.every((t) => t.widgets.length === 0)) {
          ws.replaceTabs(buildDefaultTabs(current));
        }
      } catch {
        // No dataset yet is a normal state, not an error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setInfo, setDatasets, setView, setCursor]);
}

/**
 * Playback clock.
 *
 * Advances by wall-clock elapsed time rather than a fixed per-frame step, so
 * `speed` means what it says regardless of render rate, and pages the view
 * forward when the cursor runs off the right edge.
 */
function usePlaybackClock() {
  const playing = usePlayback((s) => s.playing);
  const info = useData((s) => s.info);

  useEffect(() => {
    if (!playing || !info) return;
    let raf = 0;
    // Seeded on the first callback, not from performance.now(): rAF reports the
    // frame's start time, which can precede the moment this effect ran, and a
    // negative first delta would walk the cursor backwards off the start of the
    // log.
    let last = -1;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (last < 0) {
        last = now;
        return;
      }
      // Clamp the step so a backgrounded tab resumes rather than jumping.
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
      last = now;

      const p = usePlayback.getState();
      const next = Math.max(info.t0, p.cursor + dt * p.speed);

      if (next >= info.t1) {
        p.setCursor(info.t1);
        p.setPlaying(false);
        return;
      }
      p.setCursor(next);

      const span = p.viewT1 - p.viewT0;
      if (next > p.viewT1) {
        const a = Math.max(info.t0, Math.min(next, info.t1 - span));
        p.setView(a, a + span);
      } else if (next < p.viewT0) {
        const a = Math.max(info.t0, next);
        p.setView(a, a + span);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, info]);
}

/** Extend the timeline as a live source appends frames. */
function useLiveFeed() {
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    listen<LiveTick>(EV_LIVE_FRAMES, (tick) => {
      const d = useData.getState();
      if (!d.info || d.info.id !== tick.datasetId) return;

      d.setInfo({ ...d.info, frames: tick.frames, t1: tick.t1 });
      d.bumpVersion();

      const p = usePlayback.getState();
      if (p.follow) {
        p.setCursor(tick.t1);
        const span = p.viewT1 - p.viewT0;
        p.setView(Math.max(d.info.t0, tick.t1 - span), tick.t1);
      } else if (p.viewT1 >= d.info.t1 - 1e-9) {
        // The view was pinned to the end; grow it rather than leave a gap.
        p.setView(p.viewT0, tick.t1);
      }
      // A schema change means new channels are pickable.
      if (tick.newChannels.length) {
        datasetInfo(tick.datasetId).then((fresh) => fresh && d.setInfo(fresh)).catch(() => {});
      }
    }).then((u) => unsubs.push(u));

    listen<LiveEnded>(EV_LIVE_ENDED, (ended) => {
      const d = useData.getState();
      d.setLive(null);
      if (ended.error) d.setError(`Live source stopped: ${ended.error}`);
      else d.setNotice("Live source stopped.");
      datasetInfo(ended.datasetId).then((fresh) => fresh && d.setInfo(fresh)).catch(() => {});
    }).then((u) => unsubs.push(u));

    return () => unsubs.forEach((u) => u());
  }, []);
}

/** Transport keyboard shortcuts, suppressed while typing. */
function useTransportKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return;
      }

      const p = usePlayback.getState();
      const d = useData.getState();
      const info = d.info;
      const frameDt =
        info && info.frames > 1 ? (info.t1 - info.t0) / (info.frames - 1) : 0.01;
      const clamp = (t: number) =>
        info ? Math.min(info.t1, Math.max(info.t0, t)) : t;

      switch (e.key) {
        case " ":
          e.preventDefault();
          p.setPlaying(!p.playing);
          break;
        case "ArrowLeft":
          e.preventDefault();
          p.setFollow(false);
          p.setCursor(clamp(p.cursor - frameDt * (e.shiftKey ? 25 : 1)));
          break;
        case "ArrowRight":
          e.preventDefault();
          p.setFollow(false);
          p.setCursor(clamp(p.cursor + frameDt * (e.shiftKey ? 25 : 1)));
          break;
        case "Home":
          if (info) p.setCursor(info.t0);
          break;
        case "End":
          if (info) p.setCursor(info.t1);
          break;
        case ",":
        case ".": {
          const evs = info?.events ?? [];
          const next =
            e.key === "."
              ? evs.find((x) => x.t > p.cursor + 1e-6)
              : [...evs].reverse().find((x) => x.t < p.cursor - 1e-6);
          if (next) {
            p.setFollow(false);
            p.setCursor(next.t);
          }
          break;
        }
        case "f":
        case "F":
          if (info) p.setView(info.t0, info.t1);
          break;
        case "m":
        case "M": {
          if (!info) break;
          const label = window.prompt("Marker label", `Marker ${fmtTime(p.cursor)}`);
          if (label) addMarker(p.cursor, label, info.id).then(d.setEvents).catch(() => {});
          break;
        }
        case "c":
        case "C": {
          const ws = useWorkspace.getState();
          ws.setChatOpen(!ws.chatOpen);
          break;
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
