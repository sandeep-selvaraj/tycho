import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { cursor, type AdapterSpec } from '@tycho/adapters';
import { openDb, queries } from '@tycho/db';
import { appendBubble, makeCursorUser } from '../../adapters/src/cursor/fixtures/make-db';
import { normalizeCursorTool } from '../../adapters/src/cursor/transform';
import { Ingestor } from './ingestor';

const at = (dir: string): AdapterSpec => ({ ...cursor, discover: { ...cursor.discover, roots: { default: [dir], darwin: [dir], linux: [dir], win32: [dir] } } });
const all = (db: Database.Database, sql: string) => db.prepare(sql).all();
const get = (db: Database.Database, sql: string) => db.prepare(sql).get();

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tycho-cur-'));
  const T = makeCursorUser(dir);
  const db = openDb(':memory:');
  return { dir, T, db, ing: new Ingestor(db, at(dir)) };
}

describe('cursor adapter', () => {
  it('discovers only the global state database', () => {
    expect(cursor.discover.match(path.join('globalStorage', 'state.vscdb'))).toBe(true);
    expect(cursor.discover.match(path.join('globalStorage', 'state.vscdb.pathfix-backup'))).toBe(false);
    expect(cursor.discover.match(path.join('workspaceStorage', 'x', 'state.vscdb'))).toBe(false);
  });

  it('builds sessions with titles, projects and subagents', () => {
    const { db, ing, T } = setup();
    expect(ing.backfill()).toMatchObject([{ skipped: 0 }]);
    expect(all(db, `SELECT id, title, project_path p, parent_session_id parent FROM sessions ORDER BY id`)).toEqual([
      { id: 'cursor:c-new', title: 'Invoice validation', p: '/Users/dev/rechnify', parent: null },
      { id: 'cursor:c-old', title: 'Old chat about caching', p: '/Users/dev/old-app', parent: null },
      { id: 'cursor:c-sub', title: 'Explore validators', p: null, parent: 'cursor:c-new' },
    ]);
    expect(get(db, `SELECT started_at s, updated_at u FROM sessions WHERE id='cursor:c-new'`)).toEqual({
      s: new Date(T).toISOString(), u: new Date(T + 60_000).toISOString(),
    });
  });

  it('skips the blank conversation Cursor writes for every opened chat tab', () => {
    const { db, ing } = setup();
    ing.backfill();
    expect(get(db, `SELECT COUNT(*) n FROM sessions WHERE id='cursor:c-empty'`)).toEqual({ n: 0 });
    expect(queries.sessions(db, {}, new Date(0)).some((r) => r.title === '(untitled)')).toBe(false);
  });

  it('takes "running" from Cursor\'s own status', () => {
    const { dir, db, ing, T } = setup();
    ing.backfill();
    const at = new Date(T + 150_000);
    // Completed 90 s ago: not running, though recency alone (two minutes) would still say so.
    expect(queries.sessions(db, {}, at).find((r) => r.id === 'cursor:c-new')?.live).toBe(false);
    const h = new Database(path.join(dir, 'globalStorage', 'state.vscdb'));
    const c = JSON.parse(h.prepare(`SELECT value FROM cursorDiskKV WHERE key='composerData:c-new'`).pluck().get() as string);
    h.prepare(`UPDATE cursorDiskKV SET value = ? WHERE key='composerData:c-new'`).run(JSON.stringify({ ...c, status: 'generating', lastUpdatedAt: T + 120_000 }));
    h.close();
    ing.backfill();
    // Mid-turn and quiet for five minutes (a long tool call): still running.
    expect(queries.sessions(db, {}, new Date(T + 420_000)).find((r) => r.id === 'cursor:c-new')?.live).toBe(true);
  });

  it('keeps bubbles in their own conversation (key ranges do not leak)', () => {
    const { db, ing } = setup();
    ing.backfill();
    expect(get(db, `SELECT COUNT(*) n FROM messages WHERE text = 'orphan'`)).toEqual({ n: 0 });
    expect(all(db, `SELECT role, text FROM messages WHERE session_id='cursor:c-new' ORDER BY timestamp`)).toEqual([
      { role: 'user', text: 'Validate invoice totals before export' },
      { role: 'assistant', text: 'I will add a validator.' },
      { role: 'assistant', text: 'Done.' },
    ]);
  });

  it('extracts tool calls with status and duration', () => {
    const { db, ing } = setup();
    ing.backfill();
    expect(all(db, `SELECT name, native_name n, status, input, output FROM tool_calls ORDER BY name`)).toEqual([
      { name: 'read_file', n: 'read_file_v2', status: 'ok', input: '{"path":"a.py"}', output: '{"totalLinesInFile":10}' },
      { name: 'run_terminal_command', n: 'run_terminal_command_v2', status: 'error', input: '{"command":"pytest"}', output: 'exit 1' },
    ]);
    expect(queries.tools(db, {}).find((t) => t.name === 'read_file')?.avgMs).toBe(1500);
  });

  it('marks every Cursor cost as estimated and never double counts', () => {
    const { db, ing } = setup();
    ing.backfill();
    expect(all(db, `SELECT id, cost_source s, ROUND(cost_usd, 4) c, input_tokens i FROM usage_events ORDER BY id`)).toEqual([
      // c-old carries Cursor's own charge, so its token-bearing bubble is not counted again.
      { id: 'cursor:c-new:b5', s: 'estimated', c: expect.any(Number), i: 1200 },
      { id: 'cursor:c-old:usage:claude-4.5-sonnet-thinking', s: 'estimated', c: 0.49, i: 0 },
    ]);
    const rows = queries.sessions(db, {}, new Date(0));
    expect(rows.find((r) => r.id === 'cursor:c-new')).toMatchObject({ costSource: 'estimated', subagents: 1, toolErrors: 1 });
  });

  it('re-reads only conversations that changed', () => {
    const { dir, db, ing, T } = setup();
    ing.backfill();
    appendBubble(dir, T);
    const [r] = ing.backfill();
    expect(r!.records).toBeLessThan(20);
    expect(get(db, `SELECT COUNT(*) n FROM messages WHERE text = 'Also check VAT'`)).toEqual({ n: 1 });
    expect(get(db, `SELECT COUNT(*) n FROM messages WHERE session_id='cursor:c-old'`)).toEqual({ n: 1 });
  });

  it('never writes to the Cursor database', () => {
    const { dir, ing } = setup();
    const file = path.join(dir, 'globalStorage', 'state.vscdb');
    const v = () => new Database(file, { readonly: true }).prepare('PRAGMA data_version').pluck().get();
    const before = v();
    ing.backfill();
    expect(v()).toBe(before);
  });

  it('fails soft when the schema drifts', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tycho-cur-'));
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(path.join(dir, 'globalStorage'));
    const h = new Database(path.join(dir, 'globalStorage', 'state.vscdb'));
    h.exec(`CREATE TABLE ItemTable (key TEXT, value BLOB)`); // a future Cursor without cursorDiskKV
    h.close();
    const db = openDb(':memory:');
    expect(() => new Ingestor(db, at(dir)).backfill()).not.toThrow();
    writeFileSync(path.join(dir, 'globalStorage', 'state.vscdb'), 'garbage');
    new Ingestor(db, at(dir)).backfill();
    expect(get(db, `SELECT health FROM sources`)).toEqual({ health: 'failing' });
  });

  it('normalizes tool names', () => {
    expect(normalizeCursorTool('edit_file_v2')).toBe('edit_file');
    expect(normalizeCursorTool('mcp-cursor-ide-browser-browser_cdp')).toBe('mcp-cursor-ide-browser-browser_cdp');
  });
});

describe('cursor session model', () => {
  it('falls back to the model named on messages when there is no usage', () => {
    const { db, ing } = setup();
    ing.backfill();
    expect(queries.sessions(db, {}, new Date(0)).find((r) => r.id === 'cursor:c-new')?.model).toBe('claude-4.5-sonnet');
  });
});

describe('async ingestion', () => {
  it('yields between batches and gives the same result as the sync path', async () => {
    const { dir, db } = setup();
    const ing = new Ingestor(db, at(dir), undefined, { sqliteBatch: 2 });
    let turns = 0;
    const tick = () => {
      turns++;
      if (!done) setImmediate(tick);
    };
    let done = false;
    setImmediate(tick);
    await ing.backfillAsync();
    done = true;
    expect(turns).toBeGreaterThan(3);
    expect(db.prepare(`SELECT COUNT(*) FROM messages WHERE session_id LIKE 'cursor:%'`).pluck().get()).toBe(5);
  });

  it('coalesces concurrent requests for the same source', async () => {
    const { dir, db, ing } = setup();
    const src = { file: path.join(dir, 'globalStorage', 'state.vscdb'), root: dir };
    const [a, b] = await Promise.all([ing.ingestFileAsync(src), ing.ingestFileAsync(src)]);
    expect(a).toBe(b);
    expect(db.prepare(`SELECT COUNT(*) FROM tool_calls`).pluck().get()).toBe(2);
  });
});

describe('cursor workspace paths', () => {
  it('keeps drive-less file URLs readable on every OS', async () => {
    const { pathToFileURL } = await import('node:url');
    const { mkdirSync } = await import('node:fs');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tycho-cur-'));
    makeCursorUser(dir);
    // A workspace.json written with this OS's own URL form must round-trip exactly.
    const native = path.join(os.tmpdir(), 'tycho native app');
    mkdirSync(path.join(dir, 'workspaceStorage', 'ws-native'), { recursive: true });
    writeFileSync(path.join(dir, 'workspaceStorage', 'ws-native', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(native).href }));
    const h = new Database(path.join(dir, 'globalStorage', 'state.vscdb'));
    h.prepare(`INSERT INTO cursorDiskKV VALUES ('composerData:c-native', ?)`).run(JSON.stringify({ composerId: 'c-native', name: 'Native', createdAt: 1, lastUpdatedAt: 1, workspaceIdentifier: { id: 'ws-native' } }));
    h.close();
    const db = openDb(':memory:');
    new Ingestor(db, at(dir)).backfill();
    expect(get(db, `SELECT project_path p FROM sessions WHERE id='cursor:c-native'`)).toEqual({ p: native });
  });
});
