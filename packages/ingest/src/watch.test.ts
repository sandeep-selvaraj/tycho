import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
});
