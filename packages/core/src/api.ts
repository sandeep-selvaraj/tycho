import type { CostSource } from './model';

/** Row shape for the session list ("strip"). */
export interface SessionRow {
  id: string;
  harness: string;
  title: string;
  projectPath: string | null;
  model: string | null;
  startedAt: string;
  updatedAt: string;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
  costUsd: number;
  costSource: CostSource | null;
  live: boolean;
  subagents: number;
  /** Titles of subagents that are running right now (a subset of `subagents`). */
  runningSubagents: string[];
  /** True when some usage has no known price, so costUsd is a lower bound. */
  unpriced: boolean;
}

export interface OverviewData {
  costToday: number;
  cost7d: number;
  cost30d: number;
  liveCount: number;
  sessionCount: number;
  daily: { day: string; harness: string; costUsd: number }[];
  byModel: { model: string; harness: string; costUsd: number; unpriced: boolean }[];
  cacheReadShare: number | null;
}

export interface SessionDetail {
  session: SessionRow;
  toolCalls: { id: string; name: string; status: string; startedAt: string | null; endedAt: string | null; sessionId: string }[];
  turns: { timestamp: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null }[];
  messages: { id: string; role: string; timestamp: string; model: string | null; text: string | null; sessionId: string }[];
  /** Messages beyond this cap were not returned. */
  truncated: boolean;
}

export interface SourceRow {
  sourceRef: string;
  harness: string;
  health: 'ok' | 'degraded' | 'failing';
  lastError: string | null;
  lastIngestAt: string | null;
  records: number;
}

export interface ToolStat {
  name: string;
  harness: string;
  calls: number;
  errors: number;
  /** Mean of calls that have both a start and an end; null when none do. */
  avgMs: number | null;
  p90Ms: number | null;
}

export interface HarnessStat {
  harness: string;
  sessions: number;
  costUsd: number;
  tokens: number;
  toolCalls: number;
  toolErrors: number;
  cacheReadShare: number | null;
  /** Average cost of a top-level session (subagents rolled in). */
  costPerSession: number;
}

export interface SearchHit {
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  harness: string;
  projectPath: string | null;
  role: string;
  timestamp: string;
  /** Excerpt with matches wrapped in \u0002 … \u0003 (render as <mark>, never as HTML). */
  snippet: string;
}

export interface SearchQuery {
  q: string;
  harness?: string;
  /** Only messages from the last N days. */
  days?: number;
  limit?: number;
}

/** The typed surface the preload exposes as `window.tycho`. Every method is one IPC channel. */
export interface TychoApi {
  overview(): Promise<OverviewData>;
  sessions(q: { harness?: string; limit?: number; offset?: number }): Promise<SessionRow[]>;
  session(id: string): Promise<SessionDetail | null>;
  sources(): Promise<SourceRow[]>;
  tools(q: { harness?: string; days?: number }): Promise<ToolStat[]>;
  harnesses(q: { days?: number }): Promise<HarnessStat[]>;
  search(q: SearchQuery): Promise<SearchHit[]>;
  onChange(cb: (topic: 'usage' | 'sessions' | 'sources') => void): () => void;
  /** Main asks the UI to show a session (e.g. picked from the tray). */
  onOpenSession(cb: (id: string) => void): () => void;
}

export const IPC = {
  overview: 'tycho:overview',
  sessions: 'tycho:sessions',
  session: 'tycho:session',
  sources: 'tycho:sources',
  tools: 'tycho:tools',
  harnesses: 'tycho:harnesses',
  search: 'tycho:search',
  change: 'tycho:change',
  openSession: 'tycho:open-session',
} as const;
