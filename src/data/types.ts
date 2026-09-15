/** Types mirroring the Rust store's serde output. */

export interface ChannelMeta {
  name: string;
  unit: string | null;
  min: number;
  max: number;
  count: number;
}

export interface FlightEvent {
  t: number;
  label: string;
  /** `state` | `detected` | `marker` */
  kind: string;
}

export interface DatasetInfo {
  id: string;
  name: string;
  source: string;
  t0: number;
  t1: number;
  frames: number;
  live: boolean;
  channels: ChannelMeta[];
  events: FlightEvent[];
}

export interface SeriesData {
  name: string;
  unit: string | null;
  values: (number | null)[];
}

export interface RangeQuery {
  times: number[];
  series: SeriesData[];
  sourceFrames: number;
  decimated: boolean;
}

export interface ChannelStats {
  name: string;
  unit: string | null;
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  stddev: number | null;
  first: number | null;
  last: number | null;
  tMin: number | null;
  tMax: number | null;
}

export interface LoadReport {
  warnings: string[];
  timeBasis: string;
}

export interface LoadResult {
  info: DatasetInfo;
  report: LoadReport;
}

export interface LiveTick {
  datasetId: string;
  frames: number;
  t1: number;
  newChannels: string[];
}

export interface LiveEnded {
  datasetId: string;
  error: string | null;
}

export interface ProviderConfig {
  kind: string;
  model: string;
  baseUrl: string | null;
  maxTokens: number;
}

export interface LlmStatus {
  configured: boolean;
  kind: string;
  model: string;
  baseUrl: string | null;
  keySource: string;
}

export interface ToolTrace {
  name: string;
  input: Record<string, unknown>;
  summary: string;
  isError: boolean;
}

export interface ChatReply {
  text: string;
  toolCalls: ToolTrace[];
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface ChatContextPayload {
  cursor: number;
  viewT0: number;
  viewT1: number;
  focusChannels: string[];
}

export interface UiMessage {
  role: string;
  content: string;
}
