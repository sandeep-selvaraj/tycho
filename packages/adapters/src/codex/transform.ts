import type { NormalizedRecord } from '@tycho/core';
import type { SourceCtx } from '../types';

const H = 'codex';
const TOOL_TEXT_LIMIT = 8 * 1024;

type Obj = Record<string, unknown>;
type Status = Extract<NormalizedRecord, { kind: 'tool_result' }>['status'];

interface Checkpoint {
  nativeId?: string;
  parentId?: string;
  projectPath?: string;
  historyStart?: number;
  titled?: boolean;
  model?: string;
  provider?: string;
  hasUsageRecords?: boolean;
  lastTotal?: string;
  wrappers?: string[];
}

const obj = (value: unknown): Obj | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const int = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
const count = (value: unknown) => Math.max(0, int(value) ?? 0);

function iso(value: unknown): string | undefined {
  const date = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? new Date(date).toISOString() : undefined;
}

function content(value: unknown): string | undefined {
  if (typeof value === 'string') return str(value);
  if (!Array.isArray(value)) return undefined;
  return str(value.map((part) => str(obj(part)?.text)).filter(Boolean).join('\n'));
}

function toolText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > TOOL_TEXT_LIMIT ? text.slice(0, TOOL_TEXT_LIMIT) + '\n… [truncated]' : text;
}

function outcome(value: Obj): Status {
  const exit = int(value.exit_code);
  if (exit !== undefined) return exit === 0 ? 'ok' : 'error';
  if (typeof value.success === 'boolean') return value.success ? 'ok' : 'error';
  if (typeof value.isError === 'boolean') return value.isError ? 'error' : 'ok';
  switch (value.status) {
    case 'completed':
    case 'succeeded': return 'ok';
    case 'failed':
    case 'error':
    case 'declined':
    case 'aborted':
    case 'cancelled': return 'error';
    default: return 'unknown';
  }
}

function mcpOutcome(result: Obj | undefined): Status {
  if (result && ('Err' in result || result.isError === true || obj(result.Ok)?.isError === true)) return 'error';
  return result && ('Ok' in result || result.isError === false) ? 'ok' : 'unknown';
}

function toolName(name: string): string {
  if (['exec_command', 'shell', 'shell_command', 'local_shell'].includes(name)) return 'bash';
  const mcp = /^mcp__.+?__(.+)$/.exec(name);
  return (mcp?.[1] ?? name).toLowerCase();
}

function durationStart(timestamp: string, value: unknown): string | undefined {
  const duration = obj(value);
  const seconds = int(duration?.secs);
  if (seconds === undefined || seconds < 0) return undefined;
  const start = new Date(Date.parse(timestamp) - seconds * 1000 - count(duration?.nanos) / 1e6);
  return Number.isFinite(start.getTime()) ? start.toISOString() : undefined;
}

function tokenCounts(usage: Obj, includesReasoning = true) {
  const input = count(usage.input_tokens);
  const cacheReadTokens = Math.min(input, count(usage.cached_input_tokens));
  const cacheWriteTokens = Math.min(input - cacheReadTokens, count(usage.cache_write_input_tokens));
  const reasoningTokens = count(usage.reasoning_output_tokens);
  return {
    inputTokens: input - cacheReadTokens - cacheWriteTokens,
    cacheReadTokens, cacheWriteTokens, reasoningTokens,
    outputTokens: count(usage.output_tokens) + (includesReasoning ? 0 : reasoningTokens),
  };
}

export function createJsonlTransform(ctx: SourceCtx, checkpoint: string | null) {
  const state: Checkpoint = checkpoint ? JSON.parse(checkpoint) as Checkpoint : {};
  const wrappers = new Set(state.wrappers);

  function session(nativeId: string, timestamp: string): Extract<NormalizedRecord, { kind: 'session' }> {
    return {
      kind: 'session', id: H + ':' + nativeId, harness: H, nativeId,
      projectPath: state.projectPath, sourceRef: ctx.file, timestamp,
      parentSessionId: state.parentId ? H + ':' + state.parentId : undefined,
    };
  }

  function transform(raw: unknown, ordinal: number): NormalizedRecord[] {
    const row = obj(raw);
    const p = obj(row?.payload);
    if (!row || !p) return [];

    if (row.type === 'session_meta' && !state.nativeId) {
      const nativeId = str(p.id);
      const timestamp = iso(p.timestamp) ?? iso(row.timestamp);
      if (!nativeId || !timestamp) throw new Error('Invalid Codex session metadata');
      const spawn = obj(obj(obj(p.source)?.subagent)?.thread_spawn);
      const parent = str(p.parent_thread_id) ?? str(spawn?.parent_thread_id);
      const root = str(p.session_id);
      state.nativeId = nativeId;
      state.parentId = parent && (root && root !== nativeId ? root : parent);
      state.projectPath = str(p.cwd);
      state.provider = str(p.model_provider);
      state.model = str(p.model);
      state.historyStart = int(p.subagent_history_start_ordinal);
      return [session(nativeId, timestamp)];
    }

    const timestamp = iso(row.timestamp);
    if (!state.nativeId || !timestamp || ordinal < (state.historyStart ?? 0)) return [];
    const current = session(state.nativeId, timestamp);
    const sessionId = current.id;
    const itemId = (kind: string, id: unknown) => {
      const native = str(id);
      return [sessionId, kind, native ? 'id' : 'line', native ?? ordinal].join(':');
    };
    const records: NormalizedRecord[] = [];

    const message = (role: 'user' | 'assistant', text: string | undefined, id?: unknown) => {
      if (!text?.trim()) return;
      records.push({
        kind: 'message', id: itemId('message', id), sessionId, role, timestamp, text,
        model: role === 'assistant' ? state.model : undefined, isSidechain: Boolean(state.parentId),
      });
      if (role === 'user' && !state.titled) {
        current.title = { text: text.trim().split(/\r?\n/, 1)[0]!.slice(0, 120), rank: 1 };
        state.titled = true;
      }
    };
    const tool = (id: string, nativeName: string, input: unknown, result?: { status: Status; output?: string; startedAt?: string }) => {
      const key = itemId('tool', id);
      records.push({
        kind: 'tool_call', id: key, sessionId, messageId: key, name: toolName(nativeName), nativeName,
        input: toolText(input), output: result?.output, status: result?.status ?? 'pending',
        startedAt: result?.startedAt ?? timestamp, endedAt: result?.startedAt ? timestamp : undefined,
      });
    };
    const result = (id: string, status: Status, output?: string) => {
      records.push({ kind: 'tool_result', id: itemId('tool', id), sessionId, status, output, endedAt: timestamp });
    };
    const usage = (id: unknown, tokens: Obj, includesReasoning = true) => {
      const counts = tokenCounts(tokens, includesReasoning);
      if (!counts.inputTokens && !counts.outputTokens && !counts.cacheReadTokens && !counts.cacheWriteTokens) return;
      records.push({
        kind: 'usage', id: itemId('usage', id), sessionId, timestamp,
        model: state.model ?? 'unknown', provider: state.provider, ...counts,
      });
    };

    if (row.type === 'turn_context') {
      state.model = str(p.model) ?? state.model;
      return [current];
    }

    if (row.type === 'token_usage_record') {
      const tokens = obj(p.usage);
      if (tokens && (!str(p.thread_id) || p.thread_id === state.nativeId)) {
        state.hasUsageRecords = true;
        usage(p.response_id, tokens);
      }
    }

    if (row.type === 'response_item') {
      const callId = str(p.call_id);
      const name = str(p.name);
      if (p.type === 'message' && p.role === 'assistant') message('assistant', content(p.content), p.id);
      if ((p.type === 'function_call' || p.type === 'custom_tool_call') && callId && name) {
        // Codex's custom exec dispatches the commands and edits recorded in item_completed.
        if (p.type === 'custom_tool_call' && name === 'exec') wrappers.add(callId);
        else tool(callId, name, p.arguments ?? p.input);
      }
      if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && callId && !wrappers.delete(callId)) {
        const output = content(p.output) ?? content(obj(p.output)?.content);
        const exit = /^(?:Chunk ID: [^\n]*\n)?(?:Wall time: [^\n]*\n)?(?:Process exited with code |Exit code: )(-?\d+)\b/.exec(output?.slice(0, 500) ?? '');
        const status = exit ? outcome({ exit_code: Number(exit[1]) }) : outcome(obj(p.output) ?? p);
        result(callId, status, toolText(output));
      }
    }

    if (row.type === 'event_msg') {
      const item = obj(p.item);
      const id = str(item?.id);
      const callId = str(p.call_id);
      switch (p.type) {
        case 'thread_settings_applied': {
          const settings = obj(p.thread_settings);
          state.model = str(settings?.model) ?? state.model;
          state.provider = str(settings?.model_provider_id) ?? state.provider;
          break;
        }
        case 'task_started':
        case 'task_complete':
        case 'turn_aborted': return [current];
        case 'user_message': message('user', str(p.message), p.id); break;
        case 'token_count': {
          if (state.hasUsageRecords) break;
          const info = obj(p.info);
          const total = obj(info?.total_token_usage);
          const last = obj(info?.last_token_usage);
          if (!total || !last) break;
          const key = JSON.stringify(tokenCounts(total));
          if (state.lastTotal !== key) {
            state.lastTotal = key;
            usage(undefined, last, info?.last_usage_includes_reasoning !== false);
          }
          break;
        }
        case 'exec_command_end':
        case 'patch_apply_end':
        case 'mcp_tool_call_end':
          if (callId) {
            const mcp = obj(p.result);
            const status = mcp ? mcpOutcome(mcp) : outcome(p);
            result(callId, status, toolText(str(p.aggregated_output) ?? str(p.stdout) ?? content(mcp?.content)));
          }
          break;
        case 'item_completed': {
          if (!item || !id) break;
          if (item.type === 'UserMessage') message('user', content(item.content), id);
          if (item.type === 'AgentMessage') message('assistant', content(item.content), id);
          if (item.type === 'CommandExecution' || item.type === 'FileChange' || item.type === 'McpToolCall') {
            const mcp = obj(item.result);
            const status = mcpOutcome(mcp) === 'error' ? 'error' : outcome(item);
            const startedAt = durationStart(timestamp, item.duration);
            const name = item.type === 'CommandExecution' ? 'exec_command' : item.type === 'FileChange' ? 'apply_patch' : str(item.tool);
            const output = str(item.aggregated_output) ?? str(item.stdout) ?? str(item.stderr) ?? content(mcp?.content);
            if (name) tool(id, name, item.command ?? item.changes ?? item.arguments, { status, startedAt, output: toolText(output) });
          }
          break;
        }
      }
    }

    if (records.length > 0) records.unshift(current);
    return records;
  }

  return { transform, checkpoint: () => JSON.stringify({ ...state, wrappers: [...wrappers] }) };
}
