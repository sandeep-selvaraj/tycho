import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '@tycho/core';
import { queries } from '@tycho/db';
import type BetterSqlite3 from 'better-sqlite3';

const SessionsQuery = z
  .object({
    harness: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .default({});

const Days = z.number().int().min(1).max(3650).optional();
const Range = z.object({ days: Days }).default({});
const ToolsQuery = z.object({ harness: z.string().max(64).optional(), days: Days }).default({});
const SearchQuery = z.object({
  q: z.string().max(500),
  harness: z.string().max(64).optional(),
  days: Days,
  limit: z.number().int().min(1).max(200).optional(),
});
const By = z.enum(['day', 'month', 'year']);
const CostQuery = z.object({ by: By, harness: z.string().max(64).optional() });
const CostSessionsQuery = CostQuery.extend({ period: z.string().regex(/^\d{4}(-\d{2}){0,2}$/) });

/** Every channel validates its input in main; the renderer is never trusted. */
export function registerIpc(db: BetterSqlite3.Database): void {
  ipcMain.handle(IPC.overview, () => queries.overview(db));
  ipcMain.handle(IPC.sessions, (_e, q: unknown) => queries.sessions(db, SessionsQuery.parse(q)));
  ipcMain.handle(IPC.session, (_e, id: unknown) => queries.session(db, z.string().max(512).parse(id)));
  ipcMain.handle(IPC.sources, () => queries.sources(db));
  ipcMain.handle(IPC.tools, (_e, q: unknown) => queries.tools(db, ToolsQuery.parse(q)));
  ipcMain.handle(IPC.harnesses, (_e, q: unknown) => queries.harnesses(db, Range.parse(q)));
  ipcMain.handle(IPC.costPeriods, (_e, q: unknown) => queries.costPeriods(db, CostQuery.parse(q)));
  ipcMain.handle(IPC.costSessions, (_e, q: unknown) => queries.costSessions(db, CostSessionsQuery.parse(q)));
  ipcMain.handle(IPC.search, (_e, q: unknown) => queries.search(db, SearchQuery.parse(q)));
}
