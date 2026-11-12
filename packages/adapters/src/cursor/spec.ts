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
 * Bubbles of every conversation changed since the cursor. Fields are extracted in SQLite so the
 * multi-gigabyte encrypted state and thinking blobs never cross into JavaScript.
 */
const BUBBLES = `
  WITH c AS (
    SELECT substr(key, 14) AS id,
      COALESCE(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt'), 0) AS cursor,
      json_extract(value, '$.modelConfig.modelName') AS model,
      COALESCE(json_extract(value, '$.usageData'), '{}') != '{}' AS hasUsageData
    FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' AND cursor >= @cursor
  )
  SELECT c.id AS composerId, c.cursor, c.model AS composerModel, c.hasUsageData,
    substr(b.key, length(c.id) + 11) AS bubbleId,
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
    substr(COALESCE(json_extract(b.value, '$.toolFormerData.rawArgs'), json_extract(b.value, '$.toolFormerData.params')), 1, 8192) AS toolInput,
    substr(json_extract(b.value, '$.toolFormerData.result'), 1, 8192) AS toolOutput
  FROM c JOIN cursorDiskKV b ON b.key >= 'bubbleId:' || c.id || ':' AND b.key < 'bubbleId:' || c.id || ';'`;

/**
 * Raw material for a token estimate, per conversation and day. Current Cursor versions write
 * `tokenCount: {0, 0}` on every bubble, so the only usage signals left are the context size at each
 * prompt, the model-call ids on tool bubbles, and how much text went in and out.
 */
const ESTIMATES = `
  WITH c AS (
    SELECT substr(key, 14) AS id,
      COALESCE(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt'), 0) AS cursor,
      json_extract(value, '$.modelConfig.modelName') AS model,
      json_extract(value, '$.contextTokensUsed') AS contextTokens,
      COALESCE(json_extract(value, '$.usageData'), '{}') != '{}' AS hasUsageData
    FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' AND cursor >= @cursor
  ), b AS (
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
  watch: { mode: 'mtime', debounceMs: 5000 },
  sqlite: {
    tables: [
      { name: 'composer', requires: ['cursorDiskKV.key'], sql: COMPOSERS },
      { name: 'bubble', requires: ['cursorDiskKV.key'], sql: BUBBLES },
      { name: 'estimate', requires: ['cursorDiskKV.key'], sql: ESTIMATES },
    ],
  },
  transform: (raw, ctx) => transformRow(raw as { table: string; row: Record<string, unknown> }, ctx),
};
