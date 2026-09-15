/**
 * Collapsible analysis panel.
 *
 * The model is given tools that read the loaded log directly, so it queries the
 * actual samples rather than working from a summary. Every tool call it makes
 * is shown inline as it happens — an analysis you cannot audit is not much use
 * when you are trying to work out why a deployment fired late.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  EV_CHAT_TOOL,
  IS_TAURI,
  chatSend,
  listen,
  llmStatus,
  setLlmConfig,
  setLlmKey,
} from "@/data/client";
import type { LlmStatus, ToolTrace, UiMessage } from "@/data/types";
import { useActiveTab, useData, usePlayback, useWorkspace } from "@/state/store";
import { fmtTime } from "@/widgets/chartTheme";

interface Entry {
  role: "user" | "assistant" | "error";
  content: string;
  tools?: ToolTrace[];
}

export function ChatPanel() {
  const width = useWorkspace((s) => s.chatWidth);
  const setChatWidth = useWorkspace((s) => s.setChatWidth);
  const setChatOpen = useWorkspace((s) => s.setChatOpen);

  const info = useData((s) => s.info);
  const tab = useActiveTab();
  const cursor = usePlayback((s) => s.cursor);
  const viewT0 = usePlayback((s) => s.viewT0);
  const viewT1 = usePlayback((s) => s.viewT1);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveTools, setLiveTools] = useState<ToolTrace[]>([]);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    llmStatus().then(setStatus).catch(() => {});
  }, []);

  // Tool calls stream in while the request is still running.
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<ToolTrace>(EV_CHAT_TOOL, (t) => setLiveTools((prev) => [...prev, t])).then((u) => {
      un = u;
    });
    return () => un?.();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [entries, liveTools, busy]);

  const focusChannels = useMemo(() => {
    const set = new Set<string>();
    for (const w of tab?.widgets ?? []) w.channels.forEach((c) => set.add(c));
    return [...set];
  }, [tab]);

  const send = async (text: string) => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    const next: Entry[] = [...entries, { role: "user", content: prompt }];
    setEntries(next);
    setDraft("");
    setBusy(true);
    setLiveTools([]);

    const history: UiMessage[] = next
      .filter((e) => e.role !== "error")
      .map((e) => ({ role: e.role, content: e.content }));

    try {
      const reply = await chatSend(history, {
        cursor,
        viewT0,
        viewT1,
        focusChannels,
      });
      setEntries([
        ...next,
        { role: "assistant", content: reply.text, tools: reply.toolCalls },
      ]);
    } catch (e) {
      setEntries([...next, { role: "error", content: String(e) }]);
    } finally {
      setBusy(false);
      setLiveTools([]);
    }
  };

  const suggestions = useMemo(() => {
    if (!info) return [];
    return [
      "Summarise this flight.",
      `What is happening around t = ${fmtTime(cursor)}?`,
      "Find anything anomalous in the sensor data.",
      "Which channels look like they have dropouts or noise?",
    ];
  }, [info, cursor]);

  const onResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => setChatWidth(startW + (startX - ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside className="chat" style={{ width, position: "relative" }}>
      <div className="chat-resize" onPointerDown={onResize} />

      <div className="chat-head">
        <span>✦</span>
        <b>Analyse</b>
        {status && (
          <span className="pill" title={`key source: ${status.keySource}`}>
            <span
              className="dot"
              style={{ background: status.configured ? "var(--good)" : "var(--danger)" }}
            />
            {status.model}
          </span>
        )}
        <span className="spacer" />
        {entries.length > 0 && (
          <button className="btn ghost icon" title="Clear conversation" onClick={() => setEntries([])}>
            ⟲
          </button>
        )}
        <button className="btn ghost icon" title="Model settings" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
        <button className="btn ghost icon" title="Collapse panel" onClick={() => setChatOpen(false)}>
          ✕
        </button>
      </div>

      <div className="chat-log" ref={logRef}>
        {entries.length === 0 && (
          <div className="hint">
            The model gets tools that read this log directly — it can list channels, pull any
            time range, compute statistics, and find threshold crossings. Ask it about the data
            rather than pasting numbers in.
            {!IS_TAURI && (
              <div style={{ marginTop: 8, color: "var(--accent)" }}>
                Browser preview: chat runs through the Rust backend, so start the desktop app
                with <code>npm run app</code>.
              </div>
            )}
            {IS_TAURI && status && !status.configured && (
              <div style={{ marginTop: 8, color: "var(--accent)" }}>
                No API key yet — add one under ⚙, or set <code>ANTHROPIC_API_KEY</code> in the
                environment.
              </div>
            )}
          </div>
        )}

        {entries.map((e, i) => (
          <div className={`msg ${e.role}`} key={i}>
            <div className="msg-role">
              {e.role === "user" ? "you" : e.role === "error" ? "error" : "assistant"}
            </div>
            {e.tools?.map((t, j) => <ToolRow trace={t} key={j} />)}
            <div className="msg-body selectable">{e.content}</div>
          </div>
        ))}

        {busy && (
          <div className="msg assistant">
            <div className="msg-role">assistant</div>
            {liveTools.map((t, j) => <ToolRow trace={t} key={j} />)}
            <div className="msg-body" style={{ color: "var(--text-muted)" }}>
              {liveTools.length ? "reading the log…" : "thinking…"}
            </div>
          </div>
        )}
      </div>

      <div className="chat-input">
        {entries.length === 0 && suggestions.length > 0 && (
          <div className="chat-suggestions">
            {suggestions.map((s) => (
              <button key={s} onClick={() => send(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        )}
        <textarea
          placeholder="Ask about the telemetry…  (Enter to send, Shift+Enter for a newline)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
            e.stopPropagation(); // keep transport shortcuts out of the textarea
          }}
        />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="widget-sub">
            {info ? `context: cursor ${fmtTime(cursor)}, view ${fmtTime(viewT0)}–${fmtTime(viewT1)}` : "no log loaded"}
          </span>
          <span className="spacer" />
          <button className="btn primary" onClick={() => send(draft)} disabled={busy || !draft.trim()}>
            {busy ? "…" : "Send"}
          </button>
        </div>
      </div>

      {settingsOpen && (
        <ChatSettings
          status={status}
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => setStatus(s)}
        />
      )}
    </aside>
  );
}

function ToolRow({ trace }: { trace: ToolTrace }) {
  const args = Object.entries(trace.input)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : String(v)}`)
    .join(" ");
  return (
    <div className={`tool-trace${trace.isError ? " error" : ""}`}>
      <div>
        <span className="tool-name">{trace.name}</span> {args}
      </div>
      <div>→ {trace.summary}</div>
    </div>
  );
}

function ChatSettings({
  status,
  onClose,
  onSaved,
}: {
  status: LlmStatus | null;
  onClose: () => void;
  onSaved: (s: LlmStatus) => void;
}) {
  const [kind, setKind] = useState(status?.kind ?? "anthropic");
  const [model, setModel] = useState(status?.model ?? "claude-opus-5");
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (key.trim()) await setLlmKey(kind, key.trim());
      const s = await setLlmConfig({
        kind,
        model,
        baseUrl: baseUrl.trim() || null,
        maxTokens: 16000,
      });
      onSaved(s);
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-head">
          <span>⚙</span>
          <span>Model settings</span>
        </div>
        <div className="sheet-body">
          <div className="field">
            <label>Provider</label>
            <select
              value={kind}
              onChange={(e) => {
                const k = e.target.value;
                setKind(k);
                setModel(k === "openai" ? "gpt-4o-mini" : "claude-opus-5");
                setBaseUrl("");
              }}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </div>

          <div className="field">
            <label>Model</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </div>

          {kind === "openai" && (
            <div className="field">
              <label>Base URL</label>
              <input
                placeholder="https://api.openai.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <div className="hint">
                Point this at Ollama (<code>http://localhost:11434/v1</code>) or LM Studio to run
                the analysis locally. Local endpoints need no API key.
              </div>
            </div>
          )}

          <div className="field">
            <label>API key</label>
            <input
              type="password"
              placeholder={
                status?.keySource === "env"
                  ? "using the environment variable"
                  : status?.keySource === "file"
                    ? "a key is saved — type to replace"
                    : "paste a key"
              }
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <div className="hint">
              Stored in the app config directory with owner-only permissions and read by the
              Rust backend — it is never sent to the web view. An environment variable
              (<code>ANTHROPIC_API_KEY</code> / <code>OPENAI_API_KEY</code>) takes precedence.
            </div>
          </div>

          {err && <div className="hint" style={{ color: "var(--danger)" }}>{err}</div>}
        </div>
        <div className="sheet-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
