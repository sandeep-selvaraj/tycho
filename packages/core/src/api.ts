import type { CostSource } from './model';
import type { ReleaseNotes } from './changelog';

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

export type CostGranularity = 'day' | 'month' | 'year';

/** One calendar day, month or year (local time) and what it cost. */
export interface CostPeriod {
  /** `2026-11-16`, `2026-11` or `2026`, matching the granularity asked for. */
  period: string;
  costUsd: number;
  tokens: number;
  /** Top-level sessions with usage in this period. */
  sessions: number;
  byHarness: { harness: string; costUsd: number }[];
  /** Part of the cost is an estimate, so the total is approximate. */
  estimated: boolean;
  /** Some usage has no known price, so costUsd is a lower bound. */
  unpriced: boolean;
}

/** What one session (subagents rolled in) spent inside a single period, not over its whole life. */
export interface CostSession {
  id: string;
  harness: string;
  title: string;
  projectPath: string | null;
  models: string[];
  costUsd: number;
  tokens: number;
  costSource: CostSource;
  unpriced: boolean;
  /** First and last usage inside the period. */
  firstAt: string;
  lastAt: string;
}

export interface CostQuery {
  by: CostGranularity;
  harness?: string;
}

export interface Settings {
  /** Ask GitHub for a newer release each time the app starts. Off by default. */
  checkUpdatesOnLaunch: boolean;
}

export interface AppInfo {
  version: string;
  /** The changelog this build shipped with, newest first. */
  releases: ReleaseNotes[];
  settings: Settings;
}

/** The answer to "is there a newer release?". `error` is set when the question could not be asked. */
export interface UpdateCheck {
  current: string;
  checkedAt: string;
  /** The latest published release is newer than the running version. */
  available: boolean;
  latest: { version: string; items: string[]; url: string; publishedAt: string | null } | null;
  error: string | null;
  /** Whether this copy of the app can download and install `latest` by itself; if not, why. */
  install: { possible: boolean; reason: string | null };
}

export interface UpdateProgress {
  phase: 'downloading' | 'verifying' | 'installing';
  received: number;
  total: number;
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
  /** Cost per day, month or year, newest first. */
  costPeriods(q: CostQuery): Promise<CostPeriod[]>;
  /** The sessions behind one period's cost, most expensive first. */
  costSessions(q: CostQuery & { period: string }): Promise<CostSession[]>;
  appInfo(): Promise<AppInfo>;
  setSettings(s: Settings): Promise<Settings>;
  /** Asks GitHub for the latest release. Only made when asked for. */
  checkForUpdates(): Promise<UpdateCheck>;
  /** Open the download page of the release the last check found, in the browser. */
  openUpdate(): Promise<void>;
  /**
   * Download the release the last check found, verify it, replace the installed app and restart.
   * On success the app quits, so this only ever resolves with a reason it could not be done.
   */
  installUpdate(): Promise<{ error: string }>;
  onUpdateProgress(cb: (p: UpdateProgress) => void): () => void;
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
  costPeriods: 'tycho:cost-periods',
  costSessions: 'tycho:cost-sessions',
  appInfo: 'tycho:app-info',
  setSettings: 'tycho:set-settings',
  checkForUpdates: 'tycho:check-for-updates',
  openUpdate: 'tycho:open-update',
  installUpdate: 'tycho:install-update',
  updateProgress: 'tycho:update-progress',
  change: 'tycho:change',
  openSession: 'tycho:open-session',
} as const;
