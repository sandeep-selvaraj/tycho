import type { Message, ToolCall, UsageEvent } from './model';

/** What an adapter emits. The ingest writer upserts each kind idempotently. */
export type NormalizedRecord =
  | {
      kind: 'session';
      id: string;
      harness: string;
      nativeId: string;
      sourceRef: string;
      timestamp: string;
      projectPath?: string;
      parentSessionId?: string;
      /** Higher rank wins: 3 user-set, 2 harness-generated, 1 first prompt, 0 last-resort placeholder. */
      title?: { text: string; rank: 0 | 1 | 2 | 3 };
      /**
       * What the harness itself says the agent is doing as of `timestamp`: mid-turn or waiting for the user.
       * Omit when the record says nothing about it; "running" then falls back to recent activity.
       */
      activity?: 'running' | 'idle';
    }
  | ({ kind: 'message'; raw?: string } & Message)
  | ({ kind: 'tool_call' } & ToolCall)
  | { kind: 'tool_result'; id: string; sessionId: string; status: 'ok' | 'error' | 'unknown'; output?: string; endedAt: string }
  | ({
      kind: 'usage';
      /**
       * Number of API requests this event aggregates (default 1). Prices are tiered per request,
       * so an aggregate is priced as `requests` average-sized requests rather than one huge one.
       */
      requests?: number;
    } & Omit<UsageEvent, 'costUsd' | 'costSource'> & Partial<Pick<UsageEvent, 'costUsd' | 'costSource'>>);
