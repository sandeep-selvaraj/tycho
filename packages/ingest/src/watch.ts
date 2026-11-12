import path from 'node:path';
import { watch as chokidar } from 'chokidar';
import type { Ingestor } from './ingestor';

/**
 * Watch an adapter's roots and re-ingest files as harnesses append to them.
 * Debounced per file; new files (new sessions, new projects) are picked up the same way.
 */
export function watchSources(
  ing: Ingestor,
  onIngested: (file: string, records: number) => void,
  onReady?: () => void,
): () => Promise<void> {
  const roots = ing.roots();
  const timers = new Map<string, NodeJS.Timeout>();
  const rootOf = (f: string) => roots.find((r) => f.startsWith(r + path.sep));
  const schedule = (changed: string) => {
    // SQLite sources change through their -wal / -shm siblings.
    const file = changed.replace(/-(wal|shm|journal)$/, '');
    const root = rootOf(file);
    if (!root || !ing.spec.discover.match(path.relative(root, file))) return;
    clearTimeout(timers.get(file));
    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        void ing.ingestFileAsync({ file, root }).then((r) => {
          if (r.records > 0) onIngested(file, r.records);
        });
      }, ing.spec.watch.debounceMs),
    );
  };
  const w = chokidar(roots, { ignoreInitial: true, depth: 6, awaitWriteFinish: false, persistent: true });
  w.on('add', schedule).on('change', schedule);
  if (onReady) w.once('ready', onReady);
  return async () => {
    for (const t of timers.values()) clearTimeout(t);
    await w.close();
  };
}
