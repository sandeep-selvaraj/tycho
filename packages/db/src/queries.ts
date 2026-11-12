import type BetterSqlite3 from 'better-sqlite3';
import type { HarnessStat, OverviewData, SearchHit, SearchQuery, SessionDetail, SessionRow, SourceRow, ToolStat } from '@tycho/core';

/** With no word from the harness, a session counts as running while it was written to this recently. */
const LIVE_WINDOW_MS = 2 * 60 * 1000;
/** A session the harness reports as mid-turn stays running through quiet stretches (long tools, thinking) up to this long. */
const RUNNING_WINDOW_MS = 10 * 60 * 1000;

/**
 * Whether session `x` is running. Trust the harness when it said so: 'running' holds while reasonably
 * fresh; 'idle' holds until something newer than that report is written. Otherwise use recency alone.
 */
const IS_LIVE = `(CASE
  WHEN x.activity = 'running' THEN x.updated_at >= @runningSince
  WHEN x.activity = 'idle' AND x.activity_at >= strftime('%Y-%m-%dT%H:%M:%fZ', x.updated_at, '-5 seconds') THEN 0
  ELSE x.updated_at >= @liveSince END)`;
const liveParams = (now: Date) => ({
  liveSince: new Date(now.getTime() - LIVE_WINDOW_MS).toISOString(),
  runningSince: new Date(now.getTime() - RUNNING_WINDOW_MS).toISOString(),
});

function dayStart(daysAgo: number, now: Date): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

export function overview(db: BetterSqlite3.Database, now = new Date()): OverviewData {
  const costSince = db.prepare('SELECT COALESCE(SUM(cost_usd),0) c FROM usage_events WHERE timestamp >= ?').pluck();
  const since30 = dayStart(29, now);
  const cache = db
    .prepare('SELECT SUM(cache_read_tokens) r, SUM(input_tokens + cache_read_tokens + cache_write_tokens) t FROM usage_events WHERE timestamp >= ?')
    .get(since30) as { r: number | null; t: number | null };
  return {
    costToday: costSince.get(dayStart(0, now)) as number,
    cost7d: costSince.get(dayStart(6, now)) as number,
    cost30d: costSince.get(since30) as number,
    // Same definition as a session row's `live`: top-level sessions, with their subagents rolled in.
    liveCount: db
      .prepare(
        `SELECT COUNT(*) FROM sessions s WHERE s.parent_session_id IS NULL
           AND EXISTS (SELECT 1 FROM sessions x WHERE (x.id = s.id OR x.parent_session_id = s.id) AND ${IS_LIVE})`,
      )
      .pluck()
      .get(liveParams(now)) as number,
    sessionCount: db.prepare('SELECT COUNT(*) FROM sessions WHERE parent_session_id IS NULL').pluck().get() as number,
    daily: db
      .prepare(
        `SELECT substr(u.timestamp,1,10) day, s.harness harness, COALESCE(SUM(u.cost_usd),0) costUsd
         FROM usage_events u JOIN sessions s ON s.id = u.session_id
         WHERE u.timestamp >= ? GROUP BY day, s.harness ORDER BY day`,
      )
      .all(dayStart(13, now)) as OverviewData['daily'],
    byModel: db
      .prepare(
        `SELECT u.model model, s.harness harness, COALESCE(SUM(u.cost_usd),0) costUsd, MAX(u.cost_usd IS NULL) unpriced
         FROM usage_events u JOIN sessions s ON s.id = u.session_id
         WHERE u.timestamp >= ? GROUP BY u.model, s.harness ORDER BY costUsd DESC LIMIT 8`,
      )
      .all(since30)
      .map((r) => ({ ...(r as OverviewData['byModel'][number]), unpriced: (r as { unpriced: number }).unpriced === 1 })),
    cacheReadShare: cache.t ? (cache.r ?? 0) / cache.t : null,
  };
}

// A session row rolls up its subagents (children are not listed separately, so nothing is counted twice).
const FAM = '(SELECT id FROM sessions WHERE id = s.id OR parent_session_id = s.id)';
const SESSION_SELECT = `
  SELECT s.id, s.harness, COALESCE(s.title, '(untitled)') title, s.project_path projectPath,
    s.started_at startedAt, s.updated_at updatedAt,
    COALESCE(
      (SELECT model FROM usage_events WHERE session_id = s.id GROUP BY model ORDER BY SUM(output_tokens) DESC LIMIT 1),
      (SELECT model FROM messages WHERE session_id = s.id AND model IS NOT NULL GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1)
    ) model,
    COALESCE((SELECT SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) FROM usage_events WHERE session_id IN ${FAM}),0) totalTokens,
    (SELECT COUNT(*) FROM tool_calls WHERE session_id IN ${FAM}) toolCalls,
    (SELECT COUNT(*) FROM tool_calls WHERE session_id IN ${FAM} AND status = 'error') toolErrors,
    COALESCE((SELECT SUM(cost_usd) FROM usage_events WHERE session_id IN ${FAM}),0) costUsd,
    (SELECT CASE WHEN SUM(cost_source='estimated')>0 THEN 'estimated'
                 WHEN SUM(cost_source='computed')>0 THEN 'computed'
                 WHEN COUNT(*)>0 THEN 'reported' END FROM usage_events WHERE session_id IN ${FAM}) costSource,
    EXISTS (SELECT 1 FROM usage_events WHERE session_id IN ${FAM} AND cost_usd IS NULL) unpriced,
    (SELECT COUNT(*) FROM sessions WHERE parent_session_id = s.id) subagents,
    (SELECT group_concat(COALESCE(x.title, 'subagent'), char(31)) FROM sessions x WHERE x.parent_session_id = s.id AND ${IS_LIVE}) runningSubagents,
    EXISTS (SELECT 1 FROM sessions x WHERE (x.id = s.id OR x.parent_session_id = s.id) AND ${IS_LIVE}) live
  FROM sessions s`;

type RawRow = Omit<SessionRow, 'live' | 'unpriced' | 'runningSubagents'> & { live: number; unpriced: number; runningSubagents: string | null };
const toRow = (r: RawRow): SessionRow => ({ ...r, live: r.live === 1, unpriced: r.unpriced === 1, runningSubagents: r.runningSubagents?.split('\x1f') ?? [] });

export function sessions(
  db: BetterSqlite3.Database,
  q: { harness?: string; limit?: number; offset?: number },
  now = new Date(),
): SessionRow[] {
  const rows = db
    .prepare(
      `${SESSION_SELECT}
       WHERE s.parent_session_id IS NULL AND (@harness IS NULL OR s.harness = @harness)
       ORDER BY updatedAt DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...liveParams(now), harness: q.harness ?? null, limit: q.limit ?? 200, offset: q.offset ?? 0 }) as RawRow[];
  return rows.map(toRow);
}

const MESSAGE_CAP = 2000;

export function session(db: BetterSqlite3.Database, id: string, now = new Date()): SessionDetail | null {
  const row = db
    .prepare(
      `${SESSION_SELECT} WHERE s.id = @id`,
    )
    .get({ id, ...liveParams(now) }) as RawRow | undefined;
  if (!row) return null;
  const fam = `(SELECT id FROM sessions WHERE id = @id OR parent_session_id = @id)`;
  const messages = db
    .prepare(`SELECT id, role, timestamp, model, text, session_id sessionId FROM messages WHERE session_id IN ${fam} AND text IS NOT NULL ORDER BY timestamp LIMIT ${MESSAGE_CAP + 1}`)
    .all({ id }) as SessionDetail['messages'];
  return {
    session: toRow(row),
    toolCalls: db
      .prepare(`SELECT id, name, status, started_at startedAt, ended_at endedAt, session_id sessionId FROM tool_calls WHERE session_id IN ${fam} ORDER BY started_at`)
      .all({ id }) as SessionDetail['toolCalls'],
    turns: db
      .prepare(
        `SELECT timestamp, model, input_tokens inputTokens, output_tokens outputTokens, cache_read_tokens cacheReadTokens,
           cache_write_tokens cacheWriteTokens, cost_usd costUsd FROM usage_events WHERE session_id = @id ORDER BY timestamp`,
      )
      .all({ id }) as SessionDetail['turns'],
    messages: messages.slice(0, MESSAGE_CAP),
    truncated: messages.length > MESSAGE_CAP,
  };
}

export function sources(db: BetterSqlite3.Database): SourceRow[] {
  return db
    .prepare(
      `SELECT source_ref sourceRef, harness, health, last_error lastError, last_ingest_at lastIngestAt, records
       FROM sources ORDER BY harness, source_ref`,
    )
    .all() as SourceRow[];
}

const since = (days: number | undefined, now: Date) => (days ? new Date(now.getTime() - days * 86_400_000).toISOString() : '');

export function tools(db: BetterSqlite3.Database, q: { harness?: string; days?: number }, now = new Date()): ToolStat[] {
  const rows = db
    .prepare(
      `SELECT t.name, s.harness, COUNT(*) calls, SUM(t.status = 'error') errors,
         AVG(CASE WHEN t.ended_at IS NOT NULL AND t.started_at IS NOT NULL
             THEN (julianday(t.ended_at) - julianday(t.started_at)) * 86400000 END) avgMs
       FROM tool_calls t JOIN sessions s ON s.id = t.session_id
       WHERE t.name != 'unknown' AND COALESCE(t.started_at, s.started_at) >= @since AND (@harness IS NULL OR s.harness = @harness)
       GROUP BY t.name, s.harness ORDER BY calls DESC LIMIT 200`,
    )
    .all({ since: since(q.days, now), harness: q.harness ?? null }) as Omit<ToolStat, 'p90Ms'>[];
  const durations = db.prepare(
    `SELECT (julianday(t.ended_at) - julianday(t.started_at)) * 86400000 d
     FROM tool_calls t JOIN sessions s ON s.id = t.session_id
     WHERE t.name = @name AND s.harness = @harness AND t.ended_at IS NOT NULL AND t.started_at IS NOT NULL
       AND t.started_at >= @since ORDER BY d`,
  ).pluck();
  return rows.map((r) => {
    const ds = durations.all({ name: r.name, harness: r.harness, since: since(q.days, now) }) as number[];
    return { ...r, avgMs: r.avgMs == null ? null : Math.round(r.avgMs), p90Ms: ds.length ? Math.round(ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.9))]!) : null };
  });
}

export function harnesses(db: BetterSqlite3.Database, q: { days?: number }, now = new Date()): HarnessStat[] {
  const s = since(q.days, now);
  return (
    db
      .prepare(
        `SELECT s.harness,
           (SELECT COUNT(*) FROM sessions x WHERE x.harness = s.harness AND x.parent_session_id IS NULL AND x.updated_at >= @s) sessions,
           COALESCE((SELECT SUM(u.cost_usd) FROM usage_events u JOIN sessions y ON y.id = u.session_id WHERE y.harness = s.harness AND u.timestamp >= @s),0) costUsd,
           COALESCE((SELECT SUM(u.input_tokens+u.output_tokens+u.cache_read_tokens+u.cache_write_tokens) FROM usage_events u JOIN sessions y ON y.id = u.session_id WHERE y.harness = s.harness AND u.timestamp >= @s),0) tokens,
           (SELECT SUM(u.cache_read_tokens) * 1.0 / NULLIF(SUM(u.input_tokens+u.cache_read_tokens+u.cache_write_tokens),0) FROM usage_events u JOIN sessions y ON y.id = u.session_id WHERE y.harness = s.harness AND u.timestamp >= @s) cacheReadShare,
           (SELECT COUNT(*) FROM tool_calls t JOIN sessions y ON y.id = t.session_id WHERE y.harness = s.harness AND COALESCE(t.started_at, y.started_at) >= @s) toolCalls,
           (SELECT COUNT(*) FROM tool_calls t JOIN sessions y ON y.id = t.session_id WHERE y.harness = s.harness AND t.status = 'error' AND COALESCE(t.started_at, y.started_at) >= @s) toolErrors
         FROM (SELECT DISTINCT harness FROM sessions) s ORDER BY costUsd DESC`,
      )
      .all({ s }) as Omit<HarnessStat, 'costPerSession'>[]
  )
    .filter((r) => r.sessions > 0 || r.costUsd > 0)
    .map((r) => ({ ...r, costPerSession: r.sessions ? r.costUsd / r.sessions : 0 }));
}

/** Turn free text into a safe FTS5 query: every word must match, as a prefix. */
export function ftsQuery(input: string): string | null {
  const terms = input.match(/[\p{L}\p{N}_][\p{L}\p{N}_.\-/]*/gu) ?? [];
  if (terms.length === 0) return null;
  return terms.slice(0, 12).map((t) => `"${t.replaceAll('"', '""')}"*`).join(' ');
}

export function search(db: BetterSqlite3.Database, q: SearchQuery, now = new Date()): SearchHit[] {
  const match = ftsQuery(q.q);
  if (!match) return [];
  return db
    .prepare(
      `SELECT m.id messageId, m.session_id sessionId, COALESCE(top.title, '(untitled)') sessionTitle, top.harness,
         top.project_path projectPath, m.role, m.timestamp,
         snippet(messages_fts, 0, char(2), char(3), '…', 24) snippet
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       JOIN sessions s ON s.id = m.session_id
       JOIN sessions top ON top.id = COALESCE(s.parent_session_id, s.id)
       WHERE messages_fts MATCH @match AND m.timestamp >= @since AND (@harness IS NULL OR top.harness = @harness)
       ORDER BY bm25(messages_fts) LIMIT @limit`,
    )
    .all({ match, since: since(q.days, now), harness: q.harness ?? null, limit: Math.min(q.limit ?? 50, 200) }) as SearchHit[];
}
