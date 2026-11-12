import path from 'node:path';
import type { AdapterSpec } from '../types';
import { transformRow } from './transform';

const COMPOSERS = `
  SELECT substr(c.key, 14) AS id,
    json_extract(c.value, '$.name') AS name,
    json_extract(c.value, '$.createdAt') AS createdAt,
    COALESCE(json_extract(c.value, '$.lastUpdatedAt'), json_extract(c.value, '$.createdAt'), 0) AS cursor,
    json_extract(c.value, '$.workspaceIdentifier.uri.fsPath') AS fsPath,
    json_extract(c.value, '$.workspaceIdentifier.id') AS workspaceId,
    json_extract(c.value, '$.modelConfig.modelName') AS model,
    json_extract(c.value, '$.subagentComposerIds') AS subagents,
    json_extract(c.value, '$.usageData') AS usageData,
    json_extract(c.value, '$.status') AS status,
    COALESCE(json_array_length(c.value, '$.generatingBubbleIds'), 0) AS generating,
    EXISTS (SELECT 1 FROM cursorDiskKV b WHERE b.key >= 'bubbleId:' || substr(c.key, 14) || ':' AND b.key < 'bubbleId:' || substr(c.key, 14) || ';') AS hasBubbles
  FROM cursorDiskKV c
  WHERE c.key >= 'composerData:' AND c.key < 'composerData;' AND cursor >= @cursor`;

/**
 * Conversations changed since the cursor, plus their subagents. A subagent conversation never gets
 * a `lastUpdatedAt` of its own, so without this it would be read once, at creation, and never again.
 */
const CHANGED = `
  p AS (
    SELECT substr(key, 14) AS id, value,
      COALESCE(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt'), 0) AS cursor
    FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' AND cursor >= @cursor
  ), ids AS (
    SELECT id, cursor FROM p
    UNION ALL
    SELECT j.value, p.cursor FROM p, json_each(p.value, '$.subagentComposerIds') j WHERE j.type = 'text'
  ), c AS (
    SELECT ids.id, MAX(ids.cursor) AS cursor,
      json_extract(d.value, '$.modelConfig.modelName') AS model,
      json_extract(d.value, '$.contextTokensUsed') AS contextTokens,
      COALESCE(json_extract(d.value, '$.usageData'), '{}') != '{}' AS hasUsageData
    FROM ids JOIN cursorDiskKV d ON d.key = 'composerData:' || ids.id GROUP BY ids.id
  )`;

/** Extracted in SQLite so the multi-gigabyte encrypted state and thinking blobs never cross into JavaScript. */
const BUBBLE_FIELDS = `
    json_extract(b.value, '$.type') AS type,
    substr(json_extract(b.value, '$.text'), 1, 20000) AS text,
    json_extract(b.value, '$.createdAt') AS createdAt,
    json_extract(b.value, '$.startedAtMs') AS startedAtMs,
    json_extract(b.value, '$.completedAtMs') AS completedAtMs,
    json_extract(b.value, '$.modelInfo.modelName') AS model,
    json_extract(b.value, '$.tokenCount.inputTokens') AS inputTokens,
    json_extract(b.value, '$.tokenCount.outputTokens') AS outputTokens,
    json_extract(b.value, '$.toolFormerData.toolCallId') AS toolCallId,
    json_extract(b.value, '$.toolFormerData.name') AS toolName,
    json_extract(b.value, '$.toolFormerData.status') AS toolStatus,
    json_extract(b.value, '$.toolFormerData.additionalData.subagentComposerId') AS subagentId,
    json_extract(b.value, '$.toolFormerData.additionalData.status') AS subagentStatus,
    substr(COALESCE(json_extract(b.value, '$.toolFormerData.rawArgs'), json_extract(b.value, '$.toolFormerData.params')), 1, 8192) AS toolInput,
    substr(json_extract(b.value, '$.toolFormerData.result'), 1, 8192) AS toolOutput`;

/** Every bubble of every conversation changed since the cursor: the complete, self-correcting read. */
const BUBBLES = `
  WITH ${CHANGED}
  SELECT c.id AS composerId, c.cursor, c.model AS composerModel, c.hasUsageData,
    substr(b.key, length(c.id) + 11) AS bubbleId, ${BUBBLE_FIELDS}
  FROM c JOIN cursorDiskKV b ON b.key >= 'bubbleId:' || c.id || ':' AND b.key < 'bubbleId:' || c.id || ';'`;

/**
 * Bubbles written since the last pass, whatever conversation they belong to. Cursor only stamps a
 * conversation as updated when a turn ends, so this is what makes a running chat (and its subagents)
 * show up while it runs. The store replaces rows on write, so new and rewritten rows both get a higher
 * rowid. The first pass starts at the current end (history is BUBBLES' job); the last row carries the
 * position forward even when no bubble was written. Usage is left to BUBBLES, which knows the conversation.
 */
const NEW_BUBBLES = `
  WITH top AS (SELECT COALESCE(MAX(rowid), 0) AS r FROM cursorDiskKV)
  SELECT b.rowid AS cursor,
    substr(b.key, 10, instr(substr(b.key, 10), ':') - 1) AS composerId,
    substr(b.key, 10 + instr(substr(b.key, 10), ':')) AS bubbleId,
    NULL AS composerModel, 1 AS hasUsageData, ${BUBBLE_FIELDS}
  FROM cursorDiskKV b, top
  WHERE b.rowid >= CASE WHEN @cursor = 0 THEN top.r ELSE @cursor END AND b.key >= 'bubbleId:' AND b.key < 'bubbleId;'
  UNION ALL
  SELECT r, NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM top`;

/**
 * Raw material for a token estimate, per conversation and day. Current Cursor versions write
 * `tokenCount: {0, 0}` on every bubble, so the only usage signals left are the context size at each
 * prompt, the model-call ids on tool bubbles, and how much text went in and out.
 */
const ESTIMATES = `
  WITH ${CHANGED}, b AS (
    SELECT c.id, c.cursor, c.model AS composerModel, c.contextTokens, c.hasUsageData,
      json_extract(b.value, '$.type') AS type,
      json_extract(b.value, '$.createdAt') AS createdAt,
      json_extract(b.value, '$.modelInfo.modelName') AS model,
      json_extract(b.value, '$.toolFormerData.modelCallId') AS modelCallId,
      json_extract(b.value, '$.contextWindowStatusAtCreation.tokensUsed') AS ctx,
      COALESCE(json_extract(b.value, '$.tokenCount.inputTokens'), 0) + COALESCE(json_extract(b.value, '$.tokenCount.outputTokens'), 0) AS recorded,
      COALESCE(length(json_extract(b.value, '$.text')), 0) AS textChars,
      COALESCE(length(json_extract(b.value, '$.thinking.text')), 0) AS thinkingChars,
      COALESCE(length(json_extract(b.value, '$.toolFormerData.rawArgs')), 0) AS argChars,
      COALESCE(length(json_extract(b.value, '$.toolFormerData.result')), 0) AS resultChars
    FROM c JOIN cursorDiskKV b ON b.key >= 'bubbleId:' || c.id || ':' AND b.key < 'bubbleId:' || c.id || ';'
  )
  SELECT id AS composerId, cursor, composerModel, contextTokens, hasUsageData,
    CASE typeof(createdAt) WHEN 'text' THEN substr(createdAt, 1, 10) ELSE strftime('%Y-%m-%d', createdAt / 1000, 'unixepoch') END AS day,
    MAX(createdAt) AS lastAt,
    MAX(model) AS model,
    SUM(type = 1) AS prompts,
    COUNT(DISTINCT modelCallId) AS modelCalls,
    SUM(ctx) AS ctxSum, COUNT(ctx) AS ctxCount,
    SUM(recorded) AS recorded,
    SUM(CASE WHEN type = 1 THEN textChars ELSE 0 END) + SUM(resultChars) AS inChars,
    SUM(CASE WHEN type = 1 THEN 0 ELSE textChars END) + SUM(thinkingChars) + SUM(argChars) AS outChars
  FROM b WHERE createdAt IS NOT NULL GROUP BY id, day`;

/**
 * Cursor keeps chats in one large key-value SQLite store that it writes constantly.
 * Opened read-only, queried by key range only, polled on a long debounce. Token counts are
 * absent (model calls go through Cursor's backend), so usage is inferred and always marked estimated.
 */
export const cursor: AdapterSpec = {
  harness: 'cursor',
  displayName: 'Cursor',
  discover: {
    roots: {
      darwin: ['~/Library/Application Support/Cursor/User'],
      linux: ['$XDG_CONFIG_HOME/Cursor/User', '~/.config/Cursor/User'],
      win32: ['$APPDATA/Cursor/User'],
    },
    match: (rel) => rel === path.join('globalStorage', 'state.vscdb'),
  },
  reader: 'sqlite-table',
  // One pass over the latest conversation costs about a second; any shorter and a busy store is read non-stop.
  watch: { mode: 'mtime', debounceMs: 2000 },
  sqlite: {
    tables: [
      { name: 'composer', requires: ['cursorDiskKV.key'], sql: COMPOSERS },
      { name: 'bubble', requires: ['cursorDiskKV.key'], sql: BUBBLES },
      { name: 'new-bubble', requires: ['cursorDiskKV.key'], sql: NEW_BUBBLES },
      { name: 'estimate', requires: ['cursorDiskKV.key'], sql: ESTIMATES },
    ],
  },
  transform: (raw, ctx) => transformRow(raw as { table: string; row: Record<string, unknown> }, ctx),
};
