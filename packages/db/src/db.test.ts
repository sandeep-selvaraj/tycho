import { describe, expect, it } from 'vitest';
import { migrate, openDb, queries } from './index';

describe('db', () => {
  it('migrates idempotently and answers empty queries', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(queries.overview(db).cost30d).toBe(0);
    expect(queries.sessions(db, {})).toEqual([]);
  });

  it('aggregates cost, tools and provenance per session', () => {
    const db = openDb(':memory:');
    const now = new Date();
    const ts = now.toISOString();
    db.prepare(`INSERT INTO sessions (id,harness,native_id,project_path,title,started_at,updated_at,source_ref) VALUES ('claude-code:a','claude-code','a','/p','Fix tests',?,?,'f')`).run(ts, ts);
    const ins = db.prepare(`INSERT INTO usage_events (id, session_id, timestamp, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_source) VALUES (?, 'claude-code:a', ?, 'anthropic', 'opus', 100, 50, 900, 10, ?, 'computed')`);
    ins.run('u1', ts, 1.5);
    ins.run('u2', ts, 0.5);
    db.prepare(`INSERT INTO tool_calls VALUES ('t1','claude-code:a','m','bash','Bash',NULL,NULL,NULL,'error',NULL,NULL)`).run();
    const [row] = queries.sessions(db, {}, now);
    expect(row).toMatchObject({ subagents: 0, unpriced: false, costUsd: 2, toolCalls: 1, toolErrors: 1, costSource: 'computed', live: true, model: 'opus' });
    const ov = queries.overview(db, now);
    expect(ov.costToday).toBe(2);
    expect(ov.cacheReadShare).toBeCloseTo(1800 / (200 + 1800 + 20));
  });

  it('decides "running" from what the harness reported, falling back to recency', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-11-12T12:00:00.000Z');
    const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
    const ins = db.prepare(`INSERT INTO sessions (id,harness,native_id,started_at,updated_at,source_ref,activity,activity_at,parent_session_id) VALUES (?, 'h', ?, ?, ?, 'f', ?, ?, ?)`);
    const add = (id: string, updated: string, activity: string | null, at: string | null = updated, parent: string | null = null) => ins.run(id, id, updated, updated, activity, at, parent);
    add('just-finished', ago(5), 'idle'); // was "running" for two more minutes before
    add('long-tool', ago(300), 'running'); // quiet for five minutes mid-turn
    add('abandoned', ago(3600), 'running'); // harness died mid-turn
    add('no-signal-fresh', ago(30), null);
    add('no-signal-old', ago(600), null);
    add('written-after-idle', ago(10), 'idle', ago(90)); // new records since the harness said idle
    add('parent', ago(900), 'idle');
    add('child', ago(20), 'running', ago(20), 'parent');
    const live = Object.fromEntries(queries.sessions(db, {}, now).map((r) => [r.id, r.live]));
    expect(live).toEqual({
      'just-finished': false, 'long-tool': true, abandoned: false, 'no-signal-fresh': true, 'no-signal-old': false,
      'written-after-idle': true, parent: true,
    });
    expect(queries.overview(db, now).liveCount).toBe(4);
  });

  it('drops empty placeholder sessions left by earlier versions', () => {
    const db = openDb(':memory:');
    db.pragma('user_version = 3');
    db.exec(`ALTER TABLE sessions DROP COLUMN activity; ALTER TABLE sessions DROP COLUMN activity_at;`);
    const ins = db.prepare(`INSERT INTO sessions (id,harness,native_id,title,started_at,updated_at,source_ref,parent_session_id) VALUES (?, 'cursor', ?, ?, 't', 't', 'f', ?)`);
    ins.run('blank', 'blank', null, null);
    ins.run('titled', 'titled', 'Named but empty', null);
    ins.run('has-message', 'has-message', null, null);
    ins.run('has-child', 'has-child', null, null);
    ins.run('child', 'child', null, 'has-child');
    db.prepare(`INSERT INTO messages (id, session_id, role, timestamp, text) VALUES ('m1','has-message','user','t','hi')`).run();
    migrate(db);
    expect(db.prepare(`SELECT id FROM sessions ORDER BY id`).pluck().all()).toEqual(['child', 'has-child', 'has-message', 'titled']);
  });

  it('indexes message text in FTS', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO messages (id, session_id, role, timestamp, text) VALUES ('m1','s','user','t','add a migration for usage')`).run();
    const hit = db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'migration'`).all();
    expect(hit).toHaveLength(1);
  });
});
