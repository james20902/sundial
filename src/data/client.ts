/**
 * Backend client.
 *
 * In the Tauri app every call is an `invoke` into the Rust store. In a plain
 * browser (`npm run dev`) the same surface is served by `mock.ts`, so the UI
 * never branches on which one it is talking to.
 */

import type {
  ChannelStats,
  ChatContextPayload,
  ChatReply,
  DatasetInfo,
  FlightEvent,
  LlmStatus,
  LoadResult,
  ProviderConfig,
  RangeQuery,
  UiMessage,
} from "./types";
import {
  mockAddEvent,
  mockInfo,
  mockQueryRange,
  mockRemoveMarker,
  mockSampleAt,
  mockStats,
} from "./mock";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeImpl: InvokeFn | null = null;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeImpl) {
    const mod = await import("@tauri-apps/api/core");
    invokeImpl = mod.invoke as InvokeFn;
  }
  return invokeImpl<T>(cmd, args);
}

/** Subscribe to a backend event; resolves to an unsubscribe function. */
export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!IS_TAURI) return () => {};
  const { listen: tauriListen } = await import("@tauri-apps/api/event");
  const un = await tauriListen<T>(event, (e) => handler(e.payload));
  return un;
}

export const EV_LIVE_FRAMES = "sundial://live-frames";
export const EV_LIVE_ENDED = "sundial://live-ended";
export const EV_CHAT_TOOL = "sundial://chat-tool";

// --- datasets --------------------------------------------------------------

export async function pickAndLoadLog(): Promise<LoadResult | null> {
  if (!IS_TAURI) {
    throw new Error(
      "File loading needs the desktop app. Run `npm run app` — the browser build shows the built-in demo flight.",
    );
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    multiple: false,
    filters: [
      { name: "Flight logs", extensions: ["csv", "tsv", "txt", "jsonl", "ndjson", "log"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (typeof path !== "string") return null;
  return invoke<LoadResult>("load_log", { path });
}

export async function loadLog(path: string): Promise<LoadResult> {
  return invoke<LoadResult>("load_log", { path });
}

export async function listDatasets(): Promise<DatasetInfo[]> {
  if (!IS_TAURI) return [mockInfo()];
  return invoke<DatasetInfo[]>("list_datasets");
}

export async function datasetInfo(id?: string): Promise<DatasetInfo | null> {
  if (!IS_TAURI) return mockInfo();
  return invoke<DatasetInfo | null>("dataset_info", { id: id ?? null });
}

export async function setActiveDataset(id: string): Promise<DatasetInfo> {
  if (!IS_TAURI) return mockInfo();
  return invoke<DatasetInfo>("set_active_dataset", { id });
}

export async function closeDataset(id: string): Promise<void> {
  if (!IS_TAURI) return;
  return invoke<void>("close_dataset", { id });
}

export async function queryRange(
  channels: string[],
  t0: number,
  t1: number,
  maxPoints: number,
  id?: string,
): Promise<RangeQuery> {
  if (!IS_TAURI) return mockQueryRange(channels, t0, t1, maxPoints);
  return invoke<RangeQuery>("query_range", {
    id: id ?? null,
    channels,
    t0,
    t1,
    maxPoints,
  });
}

export async function sampleAt(
  t: number,
  channels: string[],
  id?: string,
): Promise<(number | null)[]> {
  if (!IS_TAURI) return mockSampleAt(t, channels);
  return invoke<(number | null)[]>("sample_at", {
    id: id ?? null,
    t,
    channels,
    hold: null,
  });
}

export async function channelStats(
  channels: string[],
  t0: number,
  t1: number,
  id?: string,
): Promise<ChannelStats[]> {
  if (!IS_TAURI) return mockStats(channels, t0, t1);
  return invoke<ChannelStats[]>("channel_stats", { id: id ?? null, channels, t0, t1 });
}

export async function addMarker(t: number, label: string, id?: string): Promise<FlightEvent[]> {
  if (!IS_TAURI) return mockAddEvent({ t, label, kind: "marker" });
  return invoke<FlightEvent[]>("add_marker", { id: id ?? null, t, label });
}

export async function removeMarker(t: number, id?: string): Promise<FlightEvent[]> {
  if (!IS_TAURI) return mockRemoveMarker(t);
  return invoke<FlightEvent[]>("remove_marker", { id: id ?? null, t });
}

export async function exportCsv(
  t0: number,
  t1: number,
  channels: string[] | null,
  id?: string,
): Promise<number> {
  if (!IS_TAURI) throw new Error("Export needs the desktop app.");
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: "sundial-export.csv",
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!path) return 0;
  return invoke<number>("export_csv", { id: id ?? null, path, t0, t1, channels });
}

// --- live sources ----------------------------------------------------------

export async function startLiveSource(
  kind: string,
  options: Record<string, unknown>,
): Promise<DatasetInfo> {
  if (!IS_TAURI) throw new Error("Live sources need the desktop app.");
  return invoke<DatasetInfo>("start_live_source", { config: { kind, options } });
}

export async function stopLiveSource(): Promise<void> {
  if (!IS_TAURI) return;
  return invoke<void>("stop_live_source");
}

export async function liveStatus(): Promise<string | null> {
  if (!IS_TAURI) return null;
  return invoke<string | null>("live_status");
}

// --- chat ------------------------------------------------------------------

export async function llmStatus(): Promise<LlmStatus> {
  if (!IS_TAURI) {
    return {
      configured: false,
      kind: "anthropic",
      model: "claude-opus-5",
      baseUrl: null,
      keySource: "none",
    };
  }
  return invoke<LlmStatus>("llm_status");
}

export async function setLlmConfig(config: ProviderConfig): Promise<LlmStatus> {
  if (!IS_TAURI) return llmStatus();
  return invoke<LlmStatus>("set_llm_config", { config });
}

export async function setLlmKey(kind: string, key: string): Promise<void> {
  if (!IS_TAURI) return;
  return invoke<void>("set_llm_key", { kind, key });
}

export async function chatSend(
  messages: UiMessage[],
  context: ChatContextPayload,
): Promise<ChatReply> {
  if (!IS_TAURI) {
    throw new Error(
      "The chat panel calls the model from the Rust backend. Run `npm run app` and add an API key in chat settings.",
    );
  }
  return invoke<ChatReply>("chat_send", { messages, context });
}
