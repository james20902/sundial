/**
 * Header: which log is loaded, how to load another, and the live-source
 * controls.
 */

import { useEffect, useState } from "react";
import {
  IS_TAURI,
  closeDataset,
  exportCsv,
  listDatasets,
  liveStatus,
  pickAndLoadLog,
  setActiveDataset,
  startLiveSource,
  stopLiveSource,
} from "@/data/client";
import { useData, usePlayback, useWorkspace } from "@/state/store";

export function SourceBar() {
  const info = useData((s) => s.info);
  const datasets = useData((s) => s.datasets);
  const loading = useData((s) => s.loading);
  const live = useData((s) => s.liveDescription);
  const setInfo = useData((s) => s.setInfo);
  const setDatasets = useData((s) => s.setDatasets);
  const setLoading = useData((s) => s.setLoading);
  const setError = useData((s) => s.setError);
  const setNotice = useData((s) => s.setNotice);
  const setLive = useData((s) => s.setLive);

  const viewT0 = usePlayback((s) => s.viewT0);
  const viewT1 = usePlayback((s) => s.viewT1);
  const chatOpen = useWorkspace((s) => s.chatOpen);
  const setChatOpen = useWorkspace((s) => s.setChatOpen);

  const [liveOpen, setLiveOpen] = useState(false);

  useEffect(() => {
    liveStatus().then(setLive).catch(() => {});
  }, [setLive]);

  const openLog = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await pickAndLoadLog();
      if (!res) return;
      setInfo(res.info);
      setDatasets(await listDatasets());
      const warn = res.report.warnings.length
        ? ` — ${res.report.warnings.length} warning(s): ${res.report.warnings[0]}`
        : "";
      setNotice(
        `Loaded ${res.info.frames.toLocaleString()} frames, ${res.info.channels.length} channels. Time from ${res.report.timeBasis}.${warn}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" />
        sundial
      </div>

      <button className="btn" onClick={openLog} disabled={loading}>
        {loading ? "Loading…" : "Open log…"}
      </button>

      {datasets.length > 1 && (
        <select
          value={info?.id ?? ""}
          onChange={async (e) => {
            const next = await setActiveDataset(e.target.value);
            setInfo(next);
          }}
          style={{ maxWidth: 220 }}
          title="Switch dataset"
        >
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}

      {info ? (
        <span className="pill" title={info.source}>
          <span className={`dot${info.live ? " live" : ""}`} />
          <b style={{ color: "var(--text-primary)" }}>{info.name}</b>
          <span className="num">
            {info.frames.toLocaleString()} frames · {info.channels.length} ch ·{" "}
            {(info.t1 - info.t0).toFixed(1)}s
          </span>
        </span>
      ) : (
        <span className="pill">No log loaded</span>
      )}

      {datasets.length > 1 && info && (
        <button
          className="btn ghost icon"
          title="Close this dataset"
          onClick={async () => {
            await closeDataset(info.id);
            const rest = await listDatasets();
            setDatasets(rest);
            setInfo(rest[rest.length - 1] ?? null);
          }}
        >
          ✕
        </button>
      )}

      <span className="spacer" />

      {IS_TAURI && (
        <>
          <button
            className={`btn${live ? " active" : ""}`}
            onClick={() => (live ? stopLiveSource().then(() => setLive(null)) : setLiveOpen(true))}
            title="Stream telemetry from a simulator or ground-station bridge"
          >
            {live ? `◼ Stop ${live}` : "◉ Live source…"}
          </button>
          <button
            className="btn"
            disabled={!info}
            title="Export the visible time range as CSV"
            onClick={async () => {
              try {
                const rows = await exportCsv(viewT0, viewT1, null, info?.id);
                if (rows) setNotice(`Exported ${rows.toLocaleString()} rows.`);
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            ⭳ Export view
          </button>
        </>
      )}

      <button
        className={`btn${chatOpen ? " active" : ""}`}
        onClick={() => setChatOpen(!chatOpen)}
        title="Toggle the analysis chat panel"
      >
        ✦ Analyse
      </button>

      {liveOpen && <LiveSourceSheet onClose={() => setLiveOpen(false)} />}
    </header>
  );
}

/**
 * Live-source launcher.
 *
 * UDP is the reference implementation and the intended hook for simulation
 * feeds — anything that can send a JSON datagram per control-loop iteration
 * (an OpenRocket bridge, a SITL rig, a HIL harness) appears here as a dataset.
 */
function LiveSourceSheet({ onClose }: { onClose: () => void }) {
  const setInfo = useData((s) => s.setInfo);
  const setDatasets = useData((s) => s.setDatasets);
  const setLive = useData((s) => s.setLive);
  const setError = useData((s) => s.setError);
  const [bind, setBind] = useState("127.0.0.1:9870");
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const info = await startLiveSource("udp", { bind });
      setInfo(info);
      setDatasets(await listDatasets());
      setLive(await liveStatus());
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-head">
          <span>◉</span>
          <span>Start a live source</span>
        </div>
        <div className="sheet-body">
          <div className="field">
            <label>UDP listener address</label>
            <input value={bind} onChange={(e) => setBind(e.target.value)} />
          </div>
          <div className="hint">
            Send one JSON object per control-loop frame, for example
            <br />
            <code>{'{"t": 12.84, "altitude": 431.2, "accel_z": 1.02}'}</code>
            <br />
            Any numeric field becomes a channel; an <code>event</code> field drops a marker on
            the timeline. This is the extension point for simulator feeds — bridge OpenRocket
            or a SITL rig by sending datagrams here. To add a different transport, implement{" "}
            <code>LiveSource</code> in <code>src-tauri/src/sources/</code> and register it in{" "}
            <code>build_source</code>.
          </div>
        </div>
        <div className="sheet-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={start} disabled={busy}>
            {busy ? "Starting…" : "Start listening"}
          </button>
        </div>
      </div>
    </div>
  );
}
