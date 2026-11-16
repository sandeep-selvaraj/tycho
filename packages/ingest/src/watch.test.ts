import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { claudeCode, type AdapterSpec } from '@tycho/adapters';
import { openDb } from '@tycho/db';
import { Ingestor } from './ingestor';
import { watchSources } from './watch';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('watcher', () => {
  it('ingests while a harness is still writing, not only once it goes quiet', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tycho-watch-'));
    mkdirSync(path.join(dir, '-p'));
    const file = path.join(dir, '-p', 's.jsonl');
    writeFileSync(file, '');
    const spec: AdapterSpec = { ...claudeCode, watch: { mode: 'append', debounceMs: 300 }, discover: { ...claudeCode.discover, roots: { default: [dir] }, env: undefined } };
    const db = openDb(':memory:');
    let ingests = 0;
    const stop = await new Promise<() => Promise<void>>((resolve) => {
      const s = watchSources(new Ingestor(db, spec), () => ingests++, () => resolve(s));
    });
    try {
      // Writes arrive faster than the delay for two seconds.
      for (let i = 0; i < 20; i++) {
        appendFileSync(file, `${JSON.stringify({ type: 'user', uuid: `u${i}`, sessionId: 's', timestamp: new Date().toISOString(), message: { role: 'user', content: `prompt ${i}` } })}\n`);
        await sleep(100);
      }
      expect(ingests).toBeGreaterThanOrEqual(2);
      expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBeGreaterThan(5);
    } finally {
      await stop();
    }
  });

  it('notices writes to a SQLite store that has not checkpointed', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tycho-watch-'));
    const file = path.join(dir, 'store.db');
    const harness = new Database(file);
    harness.pragma('journal_mode = WAL');
    // Like a harness mid-session: every write stays in the -wal file, which is never closed.
    harness.pragma('wal_autocheckpoint = 0');
    harness.exec('CREATE TABLE chat (id INTEGER PRIMARY KEY, at TEXT)');
    const spec: AdapterSpec = {
      harness: 'h', displayName: 'H', reader: 'sqlite-table', watch: { mode: 'mtime', debounceMs: 150 },
      discover: { roots: { default: [dir] }, match: (rel) => rel === 'store.db' },
      sqlite: { tables: [{ name: 'chat', requires: ['chat.at'], sql: 'SELECT id AS cursor, id, at FROM chat WHERE id > @cursor' }] },
      transform: (raw) => {
        const { row } = raw as { row: { id: number; at: string } };
        return [{ kind: 'session', id: `h:${row.id}`, harness: 'h', nativeId: String(row.id), sourceRef: file, timestamp: row.at }];
      },
    };
    const db = openDb(':memory:');
    const stop = await new Promise<() => Promise<void>>((resolve) => {
      const s = watchSources(new Ingestor(db, spec), () => {}, () => resolve(s));
    });
    const count = () => db.prepare('SELECT COUNT(*) FROM sessions').pluck().get() as number;
    try {
      const add = harness.prepare('INSERT INTO chat (at) VALUES (?)');
      // The first write is usually reported; the ones after it are the ones that used to be missed.
      add.run(new Date().toISOString());
      await sleep(1000);
      expect(count()).toBe(1);
      for (let i = 0; i < 3; i++) {
        add.run(new Date().toISOString());
        await sleep(300);
      }
      await sleep(700);
      expect(count()).toBe(4);
    } finally {
      await stop();
      harness.close();
    }
  });
});
