import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADAPTERS, codex } from '@tycho/adapters';
import { computeCost } from '@tycho/core';
import { openDb, queries } from '@tycho/db';
import { rootsFor } from './discover';
import { Ingestor } from './ingestor';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const now = new Date('2026-11-11T10:01:00Z');
const line = (type: string, payload: object, second = 0) => JSON.stringify({
  type, payload, timestamp: new Date(Date.UTC(2026, 10, 11, 10, 0, second)).toISOString(),
}) + '\n';
const event = (type: string, fields: object = {}, second?: number) => line('event_msg', { type, ...fields }, second);
const response = (type: string, fields: object, second?: number) => line('response_item', { type, ...fields }, second);
const item = (type: string, fields: object, second?: number) => event('item_completed', { item: { type, ...fields } }, second);

function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tycho-codex-'));
  const active = path.join(home, 'sessions');
  const archive = path.join(home, 'archived_sessions');
  const dated = path.join(active, '2026', '11', '11');
  mkdirSync(dated, { recursive: true });
  mkdirSync(archive);
  const db = openDb(':memory:');
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const roots = rootsFor(codex, { CODEX_HOME: home });
  expect(roots).toEqual([active, archive]);
  const spec = { ...codex, discover: { ...codex.discover, roots: { default: roots }, env: undefined } };
  return { db, dated, archive, ingest: () => new Ingestor(db, spec).backfill() };
}

describe('Codex ingestion', () => {
  it('imports modern active and archived rollouts once, with redacted transcripts, tools and cost', () => {
    const { db, dated, archive, ingest } = setup();
    const parent = path.join(dated, 'rollout-main.jsonl');
    const fixtureValue = 'fixture000';
    const usage = { input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 10, output_tokens: 25, reasoning_output_tokens: 5 };
    const answer = [{ type: 'output_text', text: 'Parent answer' }];
    expect(ADAPTERS).toContain(codex);

    writeFileSync(parent,
      line('session_meta', { id: 'main', cwd: '/repo', model_provider: 'openai' }) +
      line('turn_context', { model: 'gpt-5' }) +
      response('message', { id: 'injected', role: 'user', content: [{ text: 'Injected environment context' }] }) +
      item('UserMessage', { id: 'prompt', content: [{ type: 'text', text: 'Fix the pipeline\nOPENAI_API_KEY=' + fixtureValue }] }, 1) +
      response('message', { id: 'answer', role: 'assistant', content: answer }, 2) +
      item('AgentMessage', { id: 'answer', content: answer }, 2) +
      response('custom_tool_call', { call_id: 'wrapper', name: 'exec', input: 'dispatch' }, 3) +
      item('CommandExecution', {
        id: 'cmd', command: 'npm test', aggregated_output: 'OPENAI_API_KEY=' + fixtureValue,
        status: 'failed', exit_code: 1, duration: { secs: 2, nanos: 500_000_000 },
      }, 7) +
      item('FileChange', { id: 'patch', changes: { '/repo/test.ts': { type: 'add' } }, status: 'completed' }, 8) +
      response('custom_tool_call_output', { call_id: 'wrapper', output: [{ type: 'input_text', text: 'tool output' }] }, 9) +
      response('function_call', { call_id: 'mcp', name: 'mcp__server__lookup', arguments: '{}' }, 10) +
      item('McpToolCall', {
        id: 'mcp', tool: 'lookup', arguments: {}, status: 'failed', result: { isError: true, content: [{ text: 'lookup failed' }] },
        duration: { secs: 1, nanos: 0 },
      }, 11) +
      response('function_call_output', { call_id: 'mcp', output: 'lookup failed' }, 12) +
      line('token_usage_record', { thread_id: 'main', response_id: 'r1', usage }, 13));

    const childUsage = { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4 };
    writeFileSync(path.join(archive, 'rollout-child.jsonl'),
      line('session_meta', { id: 'child', session_id: 'main', parent_thread_id: 'main', subagent_history_start_ordinal: 5 }) +
      line('session_meta', { id: 'main', cwd: '/repo' }) +
      '\n' +
      response('message', { id: 'answer', role: 'assistant', content: answer }, 2) +
      line('token_usage_record', { thread_id: 'main', response_id: 'r1', usage }, 13) +
      line('turn_context', { model: 'gpt-5' }, 14) +
      response('message', { id: 'child-answer', role: 'assistant', content: [{ text: 'Subagent diagnosis' }] }, 15) +
      line('token_usage_record', { thread_id: 'child', response_id: 'r2', usage: childUsage }, 16));
    writeFileSync(path.join(archive, 'session_index.jsonl'), 'ignored\n');

    expect(ingest().map(({ skipped }) => skipped)).toEqual([0, 0]);
    appendFileSync(parent, event('token_count', { info: { total_token_usage: usage, last_token_usage: usage } }, 13));
    expect(ingest().map(({ records }) => records)).toEqual([0, 0]);
    const [session] = queries.sessions(db, { harness: 'codex' }, now);
    expect(session).toMatchObject({
      id: 'codex:main', title: 'Fix the pipeline', projectPath: '/repo', model: 'gpt-5', totalTokens: 149,
      subagents: 1, toolCalls: 3, toolErrors: 2, costSource: 'computed', unpriced: false,
    });
    expect(session!.costUsd).toBeCloseTo(
      computeCost('gpt-5', { inputTokens: 60, outputTokens: 25, cacheReadTokens: 30, cacheWriteTokens: 10 })! +
      computeCost('gpt-5', { inputTokens: 15, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 0 })!, 10,
    );
    const detail = queries.session(db, 'codex:main', now)!;
    expect(detail.messages.map(({ text }) => text)).toEqual([
      'Fix the pipeline\nOPENAI_API_KEY=[redacted]', 'Parent answer', 'Subagent diagnosis',
    ]);
    expect(detail.turns).toMatchObject([{ inputTokens: 60, outputTokens: 25, cacheReadTokens: 30, cacheWriteTokens: 10 }]);
    expect(detail.toolCalls).toMatchObject([
      { name: 'bash', status: 'error', startedAt: '2026-11-11T10:00:04.500Z', endedAt: '2026-11-11T10:00:07.000Z' },
      { name: 'apply_patch', status: 'ok', endedAt: null },
      { name: 'lookup', status: 'error', endedAt: '2026-11-11T10:00:11.000Z' },
    ]);
    expect(queries.tools(db, { harness: 'codex' }, now)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'bash', calls: 1, errors: 1, avgMs: 2500 }),
    ]));
    expect(db.prepare('SELECT output FROM tool_calls WHERE name = ?').pluck().get('bash')).toBe('OPENAI_API_KEY=[redacted]');
    expect(db.prepare('SELECT reasoning_tokens FROM usage_events WHERE session_id = ?').pluck().get('codex:main')).toBe(5);
    expect(queries.search(db, { q: 'Subagent diagnosis', harness: 'codex' }, now)).toHaveLength(1);
    expect(queries.search(db, { q: fixtureValue, harness: 'codex' }, now)).toHaveLength(0);
    expect(queries.search(db, { q: 'Injected environment', harness: 'codex' }, now)).toHaveLength(0);

    renameSync(parent, path.join(archive, 'rollout-main.jsonl'));
    ingest();
    expect(queries.session(db, 'codex:main', now)).toEqual(detail);
    expect(queries.sessions(db, { harness: 'codex' }, now)).toEqual([session]);
  });

  it('restores a legacy cursor and usage state across restarts and partial appends', () => {
    const { db, dated, ingest } = setup();
    const file = path.join(dated, 'rollout-legacy.jsonl');
    const first = { input_tokens: 200, cached_input_tokens: 80, output_tokens: 40, reasoning_output_tokens: 10 };
    const last = { input_tokens: 50, cached_input_tokens: 20, output_tokens: 7, reasoning_output_tokens: 3 };
    const next = { input_tokens: 250, cached_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 13 };
    const partial = event('token_count', {
      info: { total_token_usage: next, last_token_usage: last, last_usage_includes_reasoning: false },
    }, 7);
    writeFileSync(file,
      line('session_meta', { id: 'legacy' }) +
      event('user_message', { message: 'Inspect deployment' }, 1) +
      line('turn_context', { model: 'private-model' }, 2) +
      response('function_call', { call_id: 'legacy-cmd', name: 'exec_command', arguments: '{"cmd":"false"}' }, 3) +
      event('token_count', { info: { total_token_usage: first, last_token_usage: first } }, 4) +
      partial.slice(0, -10));
    ingest();
    expect(queries.session(db, 'codex:legacy', now)?.turns).toHaveLength(1);
    expect(ingest()[0]?.records).toBe(0);

    appendFileSync(file,
      partial.slice(-10) +
      event('token_count', { info: { last_token_usage: last, total_token_usage: next } }, 8) +
      event('exec_command_end', { call_id: 'legacy-cmd', exit_code: 1 }, 9) +
      response('function_call_output', { call_id: 'legacy-cmd', output: 'plain output' }, 10) +
      response('custom_tool_call', { call_id: 'unclassified', name: 'other_tool' }, 11) +
      response('custom_tool_call_output', { call_id: 'unclassified', output: 'some text' }, 12) +
      event('user_message', { message: 'Follow-up' }, 13) +
      '{"incomplete":}\n');
    expect(ingest()[0]?.skipped).toBe(1);
    const detail = queries.session(db, 'codex:legacy', now)!;
    expect(detail.turns).toMatchObject([
      { inputTokens: 120, outputTokens: 40, cacheReadTokens: 80, model: 'private-model', costUsd: null },
      { inputTokens: 30, outputTokens: 10, cacheReadTokens: 20, model: 'private-model', costUsd: null },
    ]);
    expect(detail.toolCalls.map(({ status }) => status)).toEqual(['error', 'unknown']);
    expect(detail.session).toMatchObject({ title: 'Inspect deployment', totalTokens: 300, unpriced: true });
    expect(queries.sources(db)).toMatchObject([{ harness: 'codex', health: 'degraded', lastError: 'Unparseable JSON line' }]);
    expect(ingest()[0]?.records).toBe(0);

    writeFileSync(file,
      line('session_meta', { id: 'new-session' }) +
      event('user_message', { message: 'A new rollout at the same path' }, 20));
    ingest();
    expect(queries.session(db, 'codex:new-session', now)?.session.title).toBe('A new rollout at the same path');
    expect(queries.session(db, 'codex:legacy', now)).toEqual(detail);
  });
});
