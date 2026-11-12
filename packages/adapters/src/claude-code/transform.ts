import path from 'node:path';
import type { NormalizedRecord } from '@tycho/core';
import type { SourceCtx } from '../types';

const H = 'claude-code';
const OUTPUT_LIMIT = 8 * 1024;

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
};
type Line = {
  type?: string;
  uuid?: string;
  sessionId?: string;
  agentId?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  requestId?: string;
  aiTitle?: string;
  customTitle?: string;
  message?: { id?: string; role?: string; model?: string; content?: string | Block[]; usage?: Usage; stop_reason?: string | null };
};

/** Session identity comes from the path: subagent files become children of their parent session. */
export function sessionFor(ctx: SourceCtx): { id: string; nativeId: string; parentSessionId?: string } {
  const rel = path.relative(ctx.root, ctx.file).split(path.sep);
  const base = path.basename(ctx.file, '.jsonl');
  if (rel.length === 4 && rel[2] === 'subagents') {
    const parent = rel[1]!;
    return { id: `${H}:${parent}/${base}`, nativeId: `${parent}/${base}`, parentSessionId: `${H}:${parent}` };
  }
  return { id: `${H}:${base}`, nativeId: base };
}

/** Lowercase, and drop MCP server prefixes so `mcp__x__read_file` groups as `read_file`. */
export function normalizeToolName(n: string): string {
  const parts = n.split('__');
  return (parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : n).toLowerCase();
}

function flattenContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b: Block) => (b?.type === 'text' ? b.text ?? '' : b?.type ? `[${b.type}]` : '')).join('\n');
  return '';
}

/** Slash commands and their local output are stored as user lines wrapped in these tags. */
const COMMAND = /^<(command-name|command-message|local-command-)/;

/** `<command-name>/plugin</command-name> … <command-args>add x</command-args>` → `/plugin add x`. */
function commandTitle(text: string): string | undefined {
  const name = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return undefined;
  const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(text)?.[1];
  return `${name}${args ? ` ${args}` : ''}`.slice(0, 120);
}

function clip(s: string): string {
  return s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT)}\n… [truncated ${s.length - OUTPUT_LIMIT} chars]` : s;
}

export function transform(raw: unknown, ctx: SourceCtx): NormalizedRecord[] {
  const l = raw as Line;
  if (!l || typeof l !== 'object') return [];
  const s = sessionFor(ctx);
  const out: NormalizedRecord[] = [];

  if (l.type === 'custom-title' && l.customTitle) {
    return [{ kind: 'session', id: s.id, harness: H, nativeId: s.nativeId, sourceRef: ctx.file, parentSessionId: s.parentSessionId, timestamp: '', title: { text: l.customTitle, rank: 3 } }];
  }
  if (l.type === 'ai-title' && l.aiTitle) {
    return [{ kind: 'session', id: s.id, harness: H, nativeId: s.nativeId, sourceRef: ctx.file, parentSessionId: s.parentSessionId, timestamp: '', title: { text: l.aiTitle, rank: 2 } }];
  }
  if ((l.type !== 'user' && l.type !== 'assistant') || !l.message || !l.timestamp || !l.uuid) return [];

  const ts = l.timestamp;
  const blocks: Block[] = Array.isArray(l.message.content) ? l.message.content : [];
  const isSidechain = Boolean(l.isSidechain);
  const session: NormalizedRecord = {
    kind: 'session', id: s.id, harness: H, nativeId: s.nativeId, sourceRef: ctx.file, timestamp: ts,
    projectPath: l.cwd, parentSessionId: s.parentSessionId,
  };
  out.push(session);

  if (l.type === 'assistant') {
    const m = l.message;
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
    // Every line of one API response repeats its stop reason: `tool_use` means the turn goes on,
    // anything else (end_turn, max_tokens, a synthetic error message) hands control back to the user.
    if (m.stop_reason) session.activity = m.stop_reason === 'tool_use' || m.stop_reason === 'pause_turn' ? 'running' : 'idle';
    out.push({ kind: 'message', id: l.uuid, sessionId: s.id, role: 'assistant', timestamp: ts, model: m.model, text: text || undefined, isSidechain });
    for (const b of blocks) {
      if (b.type !== 'tool_use' || !b.id || !b.name) continue;
      out.push({
        kind: 'tool_call', id: b.id, sessionId: s.id, messageId: l.uuid, name: normalizeToolName(b.name), nativeName: b.name,
        input: b.input === undefined ? undefined : clip(JSON.stringify(b.input)), status: 'pending', startedAt: ts,
      });
    }
    const u = m.usage;
    if (u && m.model && m.model !== '<synthetic>') {
      // One API response is split across several lines (one per content block); they repeat the same usage.
      const id = m.id && l.requestId ? `${m.id}:${l.requestId}` : m.id ?? l.uuid;
      out.push({
        kind: 'usage', id, sessionId: s.id, messageId: l.uuid, timestamp: ts, provider: 'anthropic', model: m.model,
        inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      });
    }
    return out;
  }

  // user line: tool results and/or a prompt
  for (const b of blocks) {
    if (b.type !== 'tool_result' || !b.tool_use_id) continue;
    out.push({ kind: 'tool_result', id: b.tool_use_id, sessionId: s.id, status: b.is_error ? 'error' : 'ok', output: clip(flattenContent(b.content)), endedAt: ts });
  }
  const onlyToolResults = blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
  // A tool result goes straight back to the model, so the turn is still in progress.
  if (onlyToolResults) session.activity = 'running';
  if (onlyToolResults || l.isMeta) return out;

  const text = flattenContent(l.message.content);
  if (!text) return out;
  const role = l.isCompactSummary ? 'system' : 'user';
  out.push({ kind: 'message', id: l.uuid, sessionId: s.id, role, timestamp: ts, text, isSidechain });
  // A prompt starts a turn; an interrupt ends one. Local slash commands may never reach the model, so they say nothing.
  if (text.startsWith('[Request interrupted by user')) session.activity = 'idle';
  else if (!COMMAND.test(text)) session.activity = 'running';
  // Sidechain prompts never title a main session, but a subagent's own file is nothing else: its first prompt is its task.
  if (role === 'user' && (!isSidechain || s.parentSessionId)) {
    if (!text.startsWith('<')) session.title = { text: text.split('\n')[0]!.slice(0, 120), rank: 1 };
    else {
      // Sessions made only of slash commands would otherwise stay untitled.
      const cmd = commandTitle(text);
      if (cmd) session.title = { text: cmd, rank: 0 };
    }
  }
  return out;
}
