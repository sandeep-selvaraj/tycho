import { appendFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCode, type AdapterSpec } from '@tycho/adapters';
import { openDb, queries } from '@tycho/db';
import { Ingestor } from './ingestor';
import { readJsonl } from './jsonl';

const FIXTURES = path.resolve(__dirname, '../../adapters/src/claude-code/fixtures/projects');

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tycho-'));
  cpSync(FIXTURES, dir, { recursive: true });
  const spec: AdapterSpec = { ...claudeCode, discover: { ...claudeCode.discover, roots: { default: [dir] }, env: undefined } };
  const db = openDb(':memory:');
  return { dir, db, ing: new Ingestor(db, spec) };
}
const count = (db: ReturnType<typeof openDb>, t: string) => db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get();

describe('jsonl reader', () => {
  it('holds back a partial last line and resets on truncation', () => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'tycho-')), 'a.jsonl');
    writeFileSync(f, '{"a":1}\n{"b":');
    const r1 = readJsonl(f, 0);
    expect(r1.lines).toEqual(['{"a":1}']);
    appendFileSync(f, '2}\n');
    expect(readJsonl(f, r1.nextOffset).lines).toEqual(['{"b":2}']);
    writeFileSync(f, '{"c":3}\n');
    const r3 = readJsonl(f, 999);
    expect(r3).toMatchObject({ reset: true, lines: ['{"c":3}'] });
  });
});

describe('ingestor', () => {
  it('backfills fixtures into sessions, tools and deduped usage', () => {
    const { db, ing } = setup();
    const res = ing.backfill();
    expect(res).toHaveLength(2);
    expect(count(db, 'sessions')).toBe(2);
    expect(count(db, 'usage_events')).toBe(4); // 3 in main (one deduped) + 1 subagent
    const s = db.prepare(`SELECT * FROM sessions WHERE id = 'claude-code:sess-1'`).get() as Record<string, unknown>;
    expect(s).toMatchObject({ title: 'Fix flaky login test', project_path: '/Users/dev/acme', started_at: '2026-11-01T10:00:00.000Z' });
    const tool = db.prepare(`SELECT status, ended_at FROM tool_calls WHERE id = 'toolu_1'`).get();
    expect(tool).toEqual({ status: 'error', ended_at: '2026-11-01T10:00:09.000Z' });
    const unpriced = db.prepare(`SELECT cost_usd FROM usage_events WHERE model = 'custom-proxy-llm'`).pluck().get();
    expect(unpriced).toBeNull();
  });

  it('is idempotent and resumes from the stored offset', () => {
    const { dir, db, ing } = setup();
    ing.backfill();
    const before = queries.overview(db, new Date('2026-11-01T12:00:00Z')).cost30d;
    ing.backfill();
    expect(count(db, 'usage_events')).toBe(4);
    expect(queries.overview(db, new Date('2026-11-01T12:00:00Z')).cost30d).toBeCloseTo(before);

    // The partial last line completes: exactly one new usage row appears.
    appendFileSync(path.join(dir, '-Users-dev-acme/sess-1.jsonl'), 'th more"}],"usage":{"input_tokens":1,"output_tokens":1}}}\n');
    ing.backfill();
    expect(count(db, 'usage_events')).toBe(5);
  });

  it('subagent sessions are children and stay out of the top-level list', () => {
    const { db, ing } = setup();
    ing.backfill();
    const rows = queries.sessions(db, {}, new Date('2026-11-01T12:00:00Z'));
    expect(rows.map((r) => r.id)).toEqual(['claude-code:sess-1']);
  });
});

describe('cost', () => {
  it('prices 1-hour cache writes at the 1h rate', () => {
    const { db, ing } = setup();
    ing.backfill();
    const c = db.prepare(`SELECT cost_usd FROM usage_events WHERE id = 'msg_1:req_1'`).pluck().get() as number;
    // opus-5-5: in 4e-6, out 2e-5, cache read 2e-7, 1h cache write 8e-6
    expect(c).toBeCloseTo(10 * 4e-6 + 200 * 2e-5 + 5000 * 2e-7 + 1000 * 8e-6);
  });
});

describe('session queries', () => {
  it('rolls subagent cost and tools into the parent row and detail', () => {
    const { db, ing } = setup();
    ing.backfill();
    const now = new Date('2026-11-01T12:00:00Z');
    const [row] = queries.sessions(db, {}, now);
    const all = db.prepare('SELECT SUM(cost_usd) FROM usage_events').pluck().get() as number;
    expect(row).toMatchObject({ subagents: 1, toolCalls: 2, toolErrors: 1, unpriced: true, live: false, model: 'claude-opus-5-5' });
    expect(row!.costUsd).toBeCloseTo(all);
    const d = queries.session(db, 'claude-code:sess-1', now)!;
    expect(d.toolCalls.map((t) => t.name)).toEqual(['bash', 'read_file']);
    expect(d.turns).toHaveLength(3); // the parent's own API responses only
    expect(d.messages.some((m) => m.sessionId.endsWith('agent-abc'))).toBe(true);
    expect(queries.session(db, 'nope')).toBeNull();
  });
});

describe('session titles', () => {
  it('keeps the first prompt as title, lets harness titles be renamed, and never downgrades', async () => {
    const { Writer } = await import('./writer');
    const db = openDb(':memory:');
    const w = new Writer(db);
    const put = (text: string, rank: 0 | 1 | 2 | 3) =>
      w.write([{ kind: 'session', id: 's', harness: 'h', nativeId: 's', sourceRef: 'f', timestamp: '2026-11-01T10:00:00.000Z', title: { text, rank } }]);
    const title = () => db.prepare(`SELECT title FROM sessions WHERE id='s'`).pluck().get();
    put('/plugin', 0);
    expect(title()).toBe('/plugin');
    put('Fix the login test', 1);
    put('yes', 1);
    expect(title()).toBe('Fix the login test');
    put('Login test fix', 2);
    put('Flaky login test', 2);
    expect(title()).toBe('Flaky login test');
    put('ok go', 1);
    expect(title()).toBe('Flaky login test');
  });
});
