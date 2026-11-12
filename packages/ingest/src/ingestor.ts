import { readFileSync, statSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';
import type { NormalizedRecord } from '@tycho/core';
import type { AdapterSpec } from '@tycho/adapters';
import { discover, rootsFor, type Source } from './discover';
import { readJsonl } from './jsonl';
import { openReadOnly, tableColumns } from './sqlite';
import { Writer } from './writer';

const SQLITE_BATCH = 500;

export interface IngestProgress {
  harness: string;
  done: number;
  total: number;
}

export interface IngestResult {
  file: string;
  records: number;
  skipped: number;
}

/**
 * Drives one adapter: reads each source from its stored offset, normalizes, writes, and advances the
 * offset in the same transaction so a crash can never skip data.
 */
export class Ingestor {
  private writer: Writer;
  private getState;
  private putState;
  private putSource;
  private failSource;

  constructor(
    private db: BetterSqlite3.Database,
    readonly spec: AdapterSpec,
    aliases?: Record<string, string>,
    private opts: { sqliteBatch?: number } = {},
  ) {
    this.writer = new Writer(db, aliases);
    this.getState = db.prepare('SELECT offset, last_key lastKey, mtime_ms mtimeMs FROM ingest_state WHERE source_ref = ?');
    this.putState = db.prepare(`INSERT INTO ingest_state (source_ref, kind, offset, last_key, mtime_ms, updated_at) VALUES (@ref, @kind, @offset, @lastKey, @mtime, @at)
      ON CONFLICT(source_ref) DO UPDATE SET offset = excluded.offset, last_key = excluded.last_key, mtime_ms = excluded.mtime_ms, updated_at = excluded.updated_at`);
    this.putSource = db.prepare(`INSERT INTO sources (source_ref, harness, health, last_error, skipped, last_ingest_at, records)
      VALUES (@ref, @harness, @health, @err, @skipped, @at, @records)
      ON CONFLICT(source_ref) DO UPDATE SET health = excluded.health, last_error = excluded.last_error,
        skipped = sources.skipped + excluded.skipped, last_ingest_at = excluded.last_ingest_at, records = sources.records + excluded.records`);
    this.failSource = db.prepare(`INSERT INTO sources (source_ref, harness, health, last_error) VALUES (?, ?, 'failing', ?)
      ON CONFLICT(source_ref) DO UPDATE SET health = 'failing', last_error = excluded.last_error`);
  }

  roots(): string[] {
    return rootsFor(this.spec);
  }

  discover(): Source[] {
    return discover(this.spec);
  }

  /** Ingest everything new in one source. Never throws: failures mark the source unhealthy. */
  ingestFile(src: Source): IngestResult {
    try {
      switch (this.spec.reader) {
        case 'jsonl':
          return this.ingestJsonl(src);
        case 'json-tree':
          return this.ingestJsonFile(src);
        case 'sqlite-table':
          return this.ingestSqlite(src);
      }
    } catch (e) {
      this.failSource.run(src.file, this.spec.harness, (e as Error).message);
      return { file: src.file, records: 0, skipped: 0 };
    }
  }

  private state(ref: string) {
    return this.getState.get(ref) as { offset: number | null; lastKey: string | null; mtimeMs: number | null } | undefined;
  }

  private commit(src: Source, records: NormalizedRecord[], s: { kind: string; offset?: number; lastKey?: string; mtime: number; read: number; skipped: number; error: string | null }) {
    this.db.transaction(() => {
      this.writer.write(records);
      this.putState.run({ ref: src.file, kind: s.kind, offset: s.offset ?? null, lastKey: s.lastKey ?? null, mtime: s.mtime, at: new Date().toISOString() });
      this.putSource.run({
        ref: src.file, harness: this.spec.harness, health: s.skipped ? 'degraded' : 'ok', err: s.error,
        skipped: s.skipped, at: new Date().toISOString(), records: s.read,
      });
    })();
  }

  private transformAll(raws: unknown[], src: Source) {
    const { transform } = this.spec;
    if (!transform) throw new Error('Missing record transformer');
    const records: NormalizedRecord[] = [];
    let skipped = 0;
    let error: string | null = null;
    for (const raw of raws) {
      try {
        records.push(...transform(raw, src));
      } catch (e) {
        skipped++;
        error = `Unreadable record: ${(e as Error).message}`;
      }
    }
    return { records, skipped, error };
  }

  private ingestJsonl(src: Source): IngestResult {
    const prev = this.state(src.file);
    let offset = prev?.offset ?? 0;
    const { createJsonlTransform, transform } = this.spec;
    const saved = createJsonlTransform && prev?.lastKey
      ? JSON.parse(prev.lastKey) as { ordinal: number; checkpoint: string }
      : undefined;
    let ordinal = saved?.ordinal ?? 0;
    let stateful = createJsonlTransform?.(src, saved?.checkpoint ?? null);
    let total = 0;
    let skippedAll = 0;
    for (;;) {
      const chunk = readJsonl(src.file, offset);
      if (chunk.lines.length === 0 && !chunk.reset) break;
      if (chunk.reset) {
        ordinal = 0;
        stateful = createJsonlTransform?.(src, null);
      }
      const records: NormalizedRecord[] = [];
      let read = 0;
      let skipped = 0;
      let error: string | null = null;
      for (const line of chunk.lines) {
        const index = ordinal++;
        if (!line.trim()) continue;
        read++;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          skipped++;
          error = 'Unparseable JSON line';
          continue;
        }
        try {
          records.push(...(stateful ? stateful.transform(raw, index) : transform!(raw, src)));
        } catch (e) {
          skipped++;
          error = `Unreadable record: ${(e as Error).message}`;
        }
      }
      this.commit(src, records, {
        kind: 'offset', offset: chunk.nextOffset, mtime: statSync(src.file).mtimeMs, read, skipped, error,
        lastKey: stateful ? JSON.stringify({ ordinal, checkpoint: stateful.checkpoint() }) : undefined,
      });
      total += records.length;
      skippedAll += skipped;
      if (chunk.nextOffset === offset) break;
      offset = chunk.nextOffset;
    }
    return { file: src.file, records: total, skipped: skippedAll };
  }

  /** One JSON document per file; re-read only when its mtime changes. */
  private ingestJsonFile(src: Source): IngestResult {
    const mtime = statSync(src.file).mtimeMs;
    if (this.state(src.file)?.mtimeMs === mtime) return { file: src.file, records: 0, skipped: 0 };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(src.file, 'utf8'));
    } catch {
      // Possibly mid-write; leave mtime unrecorded so the next change retries it.
      return { file: src.file, records: 0, skipped: 1 };
    }
    const { records, skipped, error } = this.transformAll([raw], src);
    this.commit(src, records, { kind: 'mtime', mtime, read: 1, skipped, error });
    return { file: src.file, records: records.length, skipped };
  }

  private ingestSqlite(src: Source): IngestResult {
    const steps = this.sqliteSteps(src);
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
    }
  }

  /**
   * Diff configured tables by cursor; the harness DB is opened read-only and never written.
   * A generator so callers decide whether to pause between batches (see `ingestFileAsync`).
   */
  private *sqliteSteps(src: Source): Generator<void, IngestResult, void> {
    const tables = this.spec.sqlite?.tables ?? [];
    const prev = this.state(src.file);
    const cursors: Record<string, number> = prev?.lastKey ? JSON.parse(prev.lastKey) : {};
    const { db: h, close } = openReadOnly(src.file);
    let total = 0;
    let skippedAll = 0;
    try {
      const cols = tableColumns(h);
      for (const t of tables) {
        const missing = t.requires.filter((r) => {
          const [table, col] = r.split('.');
          return !cols.get(table!) || (col !== undefined && !cols.get(table!)!.has(col));
        });
        if (missing.length) continue;
        const cursor = cursors[t.name] ?? 0;
        // Stream rows and commit in batches: some harness stores (Cursor) hold gigabytes.
        // The cursor only advances once the whole table pass is done; re-reads are idempotent.
        let max = cursor;
        let batch: Record<string, unknown>[] = [];
        const flush = (final: boolean) => {
          if (batch.length === 0 && !final) return;
          const { records, skipped, error } = this.transformAll(batch.map((row) => ({ table: t.name, row })), src);
          if (final) cursors[t.name] = max;
          this.commit(src, records, { kind: 'cursor', lastKey: JSON.stringify(cursors), mtime: statSync(src.file).mtimeMs, read: batch.length, skipped, error });
          total += records.length;
          skippedAll += skipped;
          batch = [];
        };
        for (const row of h.prepare(t.sql).iterate({ cursor }) as Iterable<Record<string, unknown>>) {
          max = Math.max(max, Number(row.cursor) || 0);
          batch.push(row);
          if (batch.length >= (this.opts.sqliteBatch ?? SQLITE_BATCH)) {
            flush(false);
            yield;
          }
        }
        flush(true);
      }
    } finally {
      close();
    }
    return { file: src.file, records: total, skipped: skippedAll };
  }

  private running = new Map<string, Promise<IngestResult>>();
  private dirty = new Set<string>();

  /**
   * Like `ingestFile`, but gives the event loop a turn between SQLite batches, so a multi-gigabyte
   * first pass (Cursor) never stalls watchers or IPC. Calls for a source that is already being read
   * are coalesced into one follow-up pass instead of running concurrently.
   */
  ingestFileAsync(src: Source): Promise<IngestResult> {
    const current = this.running.get(src.file);
    if (current) {
      this.dirty.add(src.file);
      return current;
    }
    const run = (async () => {
      let result: IngestResult;
      do {
        this.dirty.delete(src.file);
        result = await this.runAsync(src);
      } while (this.dirty.has(src.file));
      return result;
    })().finally(() => this.running.delete(src.file));
    this.running.set(src.file, run);
    return run;
  }

  private async runAsync(src: Source): Promise<IngestResult> {
    if (this.spec.reader !== 'sqlite-table') return this.ingestFile(src);
    try {
      const steps = this.sqliteSteps(src);
      for (;;) {
        const r = steps.next();
        if (r.done) return r.value;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (e) {
      this.failSource.run(src.file, this.spec.harness, (e as Error).message);
      return { file: src.file, records: 0, skipped: 0 };
    }
  }

  async backfillAsync(onProgress?: (p: IngestProgress) => void): Promise<IngestResult[]> {
    const sources = this.discover();
    const out: IngestResult[] = [];
    for (const [i, s] of sources.entries()) {
      out.push(await this.ingestFileAsync(s));
      onProgress?.({ harness: this.spec.harness, done: i + 1, total: sources.length });
      // Let watcher events for other sources through between files too.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return out;
  }

  backfill(onProgress?: (p: IngestProgress) => void): IngestResult[] {
    const sources = this.discover();
    return sources.map((s, i) => {
      const r = this.ingestFile(s);
      onProgress?.({ harness: this.spec.harness, done: i + 1, total: sources.length });
      return r;
    });
  }
}
