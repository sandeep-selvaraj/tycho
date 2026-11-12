/**
 * Runs in an Electron utilityProcess. Sole writer to the database: backfills every adapter,
 * then watches sources and ingests appends. Talks to main only through parentPort messages.
 */
import { ADAPTERS } from '@tycho/adapters';
import { openDb } from '@tycho/db';
import { Ingestor, redactExisting, watchSources } from '@tycho/ingest';
import type { WorkerEvent } from './worker-protocol';

const dbPath = process.argv[2];
if (!dbPath) throw new Error('ingest-worker: missing db path');

const post = (e: WorkerEvent) => process.parentPort.postMessage(e);
const db = openDb(dbPath);
const redacted = redactExisting(db);
if (redacted) post({ type: 'changed', topic: 'sessions' });

const ingestors = ADAPTERS.map((spec) => new Ingestor(db, spec));

// Start each watcher before its backfill so files created during the initial scan are picked up.
const watchReady = ingestors.map((ing) => new Promise<void>((resolve) => {
  try {
    watchSources(ing, () => post({ type: 'changed', topic: 'usage' }), resolve);
  } catch (e) {
    post({ type: 'error', harness: ing.spec.harness, message: (e as Error).message });
    resolve();
  }
}));

void (async () => {
  // Batches commit as they go; refresh the UI every couple of seconds during the first load.
  const pulse = setInterval(() => post({ type: 'changed', topic: 'sessions' }), 2000);
  for (const [index, ing] of ingestors.entries()) {
    try {
      await watchReady[index];
      let last = 0;
      await ing.backfillAsync((p) => {
        const now = Date.now();
        if (now - last > 200 || p.done === p.total) {
          last = now;
          post({ type: 'progress', ...p });
        }
      });
    } catch (e) {
      post({ type: 'error', harness: ing.spec.harness, message: (e as Error).message });
    }
  }
  clearInterval(pulse);
  post({ type: 'changed', topic: 'sessions' });
  post({ type: 'ready' });
})();
