import path from 'node:path';
import { app, ipcMain, shell } from 'electron';
import { z } from 'zod';
import { IPC, parseChangelog } from '@tycho/core';
import { queries } from '@tycho/db';
import type BetterSqlite3 from 'better-sqlite3';
// The changelog is compiled into the app, so "What's new" needs no network.
import changelog from '../../../CHANGELOG.md?raw';
import { SettingsSchema, loadSettings, saveSettings } from './settings';
import { checkForUpdates, isReleaseUrl } from './updates';
import { installBlocker, pickAssets, prepareInstall, type Asset } from './installer';

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

  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const releases = parseChangelog(changelog);
  ipcMain.handle(IPC.appInfo, () => ({ version: app.getVersion(), releases, settings: loadSettings(settingsFile) }));
  ipcMain.handle(IPC.setSettings, (_e, s: unknown) => saveSettings(settingsFile, SettingsSchema.parse(s)));
  // The renderer never names a URL or a file: it can only act on the release the last check returned.
  let found: { version: string; url: string; assets: Asset[] } | null = null;
  // Contents/MacOS/tycho -> the .app bundle this process was started from.
  const appPath = path.resolve(process.execPath, '../../..');
  ipcMain.handle(IPC.checkForUpdates, async () => {
    const { assets, ...check } = await checkForUpdates(app.getVersion());
    found = check.available ? { version: check.latest!.version, url: check.latest!.url, assets } : null;
    if (found) {
      const reason = installBlocker({ platform: process.platform, packaged: app.isPackaged, appPath })
        ?? (pickAssets(assets, process.arch) ? null : 'This release has no macOS download for this Mac that Tycho can verify.');
      check.install = { possible: reason === null, reason };
    }
    return check;
  });
  ipcMain.handle(IPC.openUpdate, async () => {
    if (found && isReleaseUrl(found.url)) await shell.openExternal(found.url);
  });
  let installing = false;
  ipcMain.handle(IPC.installUpdate, async (e) => {
    const picked = found && pickAssets(found.assets, process.arch);
    const blocker = installBlocker({ platform: process.platform, packaged: app.isPackaged, appPath });
    if (!found || !picked || blocker) return { error: blocker ?? 'Check for updates first.' };
    if (installing) return { error: 'An update is already being installed.' };
    installing = true;
    try {
      await prepareInstall({
        appPath, pid: process.pid, version: found.version, ...picked,
        workDir: path.join(app.getPath('userData'), 'update'),
        logFile: path.join(app.getPath('userData'), 'update.log'),
        onProgress: (p) => !e.sender.isDestroyed() && e.sender.send(IPC.updateProgress, p),
      });
    } catch (err) {
      installing = false;
      return { error: (err as Error).message };
    }
    // The swap is waiting for this process to exit; it starts the new version afterwards.
    app.quit();
    return { error: '' };
  });
  ipcMain.handle(IPC.search, (_e, q: unknown) => queries.search(db, SearchQuery.parse(q)));
}
