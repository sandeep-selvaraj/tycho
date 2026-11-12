import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedRecord } from '@tycho/core';
import type { SourceCtx } from '../types';

const H = 'cursor';
type Row = Record<string, unknown>;
const sid = (id: string) => `${H}:${id}`;
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const iso = (v: unknown) => {
  if (typeof v === 'number' && v > 0) return new Date(v).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return undefined;
};

/** Older conversations lack workspaceIdentifier.uri; fall back to workspaceStorage/<id>/workspace.json. */
const workspaceCache = new Map<string, string | undefined>();
function workspacePath(root: string, id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (workspaceCache.has(id)) return workspaceCache.get(id);
  let p: string | undefined;
  try {
    const w = JSON.parse(readFileSync(path.join(root, 'workspaceStorage', id, 'workspace.json'), 'utf8')) as { folder?: string; workspace?: string };
    const uri = w.folder ?? w.workspace;
    p = uri?.startsWith('file:') ? fileUrlToPath(uri) : undefined;
  } catch {
    p = undefined;
  }
  workspaceCache.set(id, p);
  return p;
}

/**
 * `fileURLToPath` throws on Windows for drive-less URLs (`file:///Users/x`, e.g. a workspace
 * recorded on another machine). Fall back to the URL's decoded path rather than losing it.
 */
function fileUrlToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    try {
      return decodeURIComponent(new URL(uri).pathname) || undefined;
    } catch {
      return undefined;
    }
  }
}

/** Cursor tool names carry version suffixes and MCP prefixes: `read_file_v2`, `mcp-server-tool`. */
export function normalizeCursorTool(n: string): string {
  return n.replace(/_v\d+$/, '').toLowerCase();
}

function toolStatus(s: unknown): 'ok' | 'error' | 'pending' | 'unknown' {
  switch (s) {
    case 'completed':
      return 'ok';
    case 'error':
    case 'cancelled':
      return 'error';
    case 'loading':
    case 'running':
      return 'pending';
    default:
      return 'unknown';
  }
}

function composer(r: Row, ctx: SourceCtx): NormalizedRecord[] {
  const id = str(r.id);
  if (!id) return [];
  // Cursor writes a blank conversation for every chat tab it opens; one with no name and no messages is not a session.
  if (!str(r.name) && !r.hasBubbles && (r.status == null || r.status === 'none')) return [];
  const created = iso(r.createdAt);
  const updated = iso(r.cursor);
  // Cursor's own state: `generating` while a turn runs, then completed / aborted / none.
  const activity = typeof r.status === 'string' ? (r.status === 'generating' || Number(r.generating) > 0 ? 'running' as const : 'idle' as const) : undefined;
  const base = {
    kind: 'session' as const, id: sid(id), harness: H, nativeId: id, sourceRef: ctx.file,
    projectPath: str(r.fsPath) ?? workspacePath(ctx.root, str(r.workspaceId)),
  };
  const out: NormalizedRecord[] = [];
  if (created) out.push({ ...base, timestamp: created, title: str(r.name) ? { text: str(r.name)!, rank: 2 } : undefined });
  if (updated && updated !== created) out.push({ ...base, timestamp: updated });
  const last = out[out.length - 1];
  if (last?.kind === 'session') last.activity = activity;

  // Subagents are separate conversations listed on their parent.
  for (const child of parseJson<string[]>(r.subagents) ?? []) {
    if (typeof child === 'string') out.push({ kind: 'session', id: sid(child), harness: H, nativeId: child, sourceRef: ctx.file, timestamp: '', parentSessionId: sid(id) });
  }

  // Cursor's own per-conversation charge, when present. Request-priced, so estimated.
  const usage = parseJson<Record<string, { costInCents?: number; amount?: number }>>(r.usageData) ?? {};
  for (const [model, u] of Object.entries(usage)) {
    if (!num(u?.costInCents)) continue;
    out.push({
      kind: 'usage', id: `${H}:${id}:usage:${model}`, sessionId: sid(id), timestamp: updated ?? created ?? new Date(0).toISOString(),
      provider: 'cursor', model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: u.costInCents! / 100, costSource: 'estimated',
    });
  }
  return out;
}

function bubble(r: Row, ctx: SourceCtx): NormalizedRecord[] {
  const composerId = str(r.composerId);
  const bubbleId = str(r.bubbleId);
  if (!composerId || !bubbleId) return [];
  const ts = iso(r.createdAt) ?? iso(r.startedAtMs);
  if (!ts) return [];
  const sessionId = sid(composerId);
  const msgId = `${H}:${composerId}:${bubbleId}`;
  const out: NormalizedRecord[] = [{ kind: 'session', id: sessionId, harness: H, nativeId: composerId, sourceRef: ctx.file, timestamp: iso(r.completedAtMs) ?? ts }];
  const text = str(r.text);
  const role = r.type === 1 ? 'user' : 'assistant';
  if (text) {
    out.push({ kind: 'message', id: msgId, sessionId, role, timestamp: ts, model: str(r.model), text });
    if (role === 'user') out.push({ kind: 'session', id: sessionId, harness: H, nativeId: composerId, sourceRef: ctx.file, timestamp: ts, title: { text: text.split('\n')[0]!.slice(0, 120), rank: 1 } });
  }
  const tool = str(r.toolName);
  // A task call names the subagent it launched and tracks it: running, then success / error / cancelled.
  // Cursor often leaves the call itself on "loading" after the subagent is done, so that status wins.
  const subagentStatus = str(r.subagentStatus);
  const subagentDone = subagentStatus !== undefined && subagentStatus !== 'running';
  const subagent = str(r.subagentId);
  if (subagent) {
    out.push({
      kind: 'session', id: sid(subagent), harness: H, nativeId: subagent, sourceRef: ctx.file, parentSessionId: sessionId,
      timestamp: (subagentDone && iso(r.completedAtMs)) || ts, activity: subagentStatus === undefined ? undefined : subagentDone ? 'idle' : 'running',
    });
  }
  if (tool) {
    out.push({
      kind: 'tool_call', id: `${H}:${str(r.toolCallId) ?? bubbleId}`, sessionId, messageId: msgId, name: normalizeCursorTool(tool), nativeName: tool,
      input: str(r.toolInput), output: str(r.toolOutput),
      status: subagentDone ? (subagentStatus === 'success' ? 'ok' : 'error') : toolStatus(r.toolStatus),
      startedAt: iso(r.startedAtMs) ?? ts, endedAt: iso(r.completedAtMs),
    });
  }
  const input = num(r.inputTokens) ?? 0;
  const output = num(r.outputTokens) ?? 0;
  // Rarely present. Skipped when the conversation carries Cursor's own charge, to avoid counting twice.
  if (input + output > 0 && !r.hasUsageData) {
    const model = str(r.model) ?? str(r.composerModel) ?? 'unknown';
    out.push({
      kind: 'usage', id: msgId, sessionId, messageId: msgId, timestamp: ts, provider: 'cursor', model,
      inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, costSource: 'estimated',
    });
  }
  return out;
}

const CHARS_PER_TOKEN = 4;

/**
 * Estimated usage for one conversation-day, used only when Cursor recorded no tokens for it.
 * Every model call re-sends the conversation, so input is dominated by context re-reads:
 * (model calls) x (average context size), counted as cache reads because Cursor caches prompts.
 * New input (prompts, tool results) and output (replies, thinking, tool arguments) come from text length.
 */
function estimate(r: Row): NormalizedRecord[] {
  const composerId = str(r.composerId);
  const day = str(r.day);
  const ts = iso(r.lastAt);
  if (!composerId || !day || !ts || r.hasUsageData || (num(r.recorded) ?? 0) > 0) return [];
  const prompts = num(r.prompts) ?? 0;
  // Tool bubbles carry the id of the call that produced them; each prompt also ends in one call with no tool.
  // A subagent that only replied (no prompt bubble, no tools) still made one.
  const requests = Math.max(1, (num(r.modelCalls) ?? 0) + prompts);
  const ctxCount = num(r.ctxCount) ?? 0;
  const context = ctxCount > 0 ? (num(r.ctxSum) ?? 0) / ctxCount : num(r.contextTokens) ?? 0;
  const inputTokens = Math.ceil((num(r.inChars) ?? 0) / CHARS_PER_TOKEN);
  const outputTokens = Math.ceil((num(r.outChars) ?? 0) / CHARS_PER_TOKEN);
  const cacheReadTokens = Math.round(requests * context);
  if (inputTokens + outputTokens + cacheReadTokens === 0) return [];
  return [{
    kind: 'usage', id: `${H}:${composerId}:estimate:${day}`, sessionId: sid(composerId), timestamp: ts, provider: 'cursor',
    model: str(r.model) ?? str(r.composerModel) ?? 'unknown', requests,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, costSource: 'estimated',
  }];
}

function parseJson<T>(v: unknown): T | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    return JSON.parse(v) as T;
  } catch {
    return undefined;
  }
}

export function transformRow(raw: { table: string; row: Row }, ctx: SourceCtx): NormalizedRecord[] {
  if (raw.table === 'composer') return composer(raw.row, ctx);
  if (raw.table === 'bubble' || raw.table === 'new-bubble') return bubble(raw.row, ctx);
  if (raw.table === 'estimate') return estimate(raw.row);
  return [];
}
