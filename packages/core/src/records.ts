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
      /** Higher rank wins: 3 user-set, 2 harness-generated, 1 first prompt. */
      title?: { text: string; rank: 1 | 2 | 3 };
    }
  | ({ kind: 'message'; raw?: string } & Message)
  | ({ kind: 'tool_call' } & ToolCall)
  | { kind: 'tool_result'; id: string; sessionId: string; status: 'ok' | 'error' | 'unknown'; output?: string; endedAt: string }
  | ({ kind: 'usage' } & Omit<UsageEvent, 'costUsd' | 'costSource'> & Partial<Pick<UsageEvent, 'costUsd' | 'costSource'>>);
