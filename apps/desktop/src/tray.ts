import path from 'node:path';
import { app, Menu, Tray, nativeImage } from 'electron';
import { queries } from '@tycho/db';
import type BetterSqlite3 from 'better-sqlite3';

const usd = (n: number) => `$${n.toFixed(2)}`;
const MAX_LIVE = 8;

function icon() {
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(__dirname, '../../assets');
  const img = nativeImage.createFromPath(path.join(dir, 'trayTemplate.png'));
  img.setTemplateImage(true);
  return img;
}

/**
 * Menu-bar item: today's API-equivalent cost as the title, running sessions in the menu.
 * Returns a refresh function; main calls it whenever usage changes.
 */
export function createTray(db: BetterSqlite3.Database, actions: { open: () => void; openSession: (id: string) => void }): () => void {
  const tray = new Tray(icon());
  tray.on('click', () => process.platform !== 'darwin' && actions.open());
  const refresh = () => {
    const o = queries.overview(db);
    const live = queries.sessions(db, { limit: 50 }).filter((s) => s.live).slice(0, MAX_LIVE);
    tray.setTitle(` ${usd(o.costToday)}`, { fontType: 'monospacedDigit' });
    tray.setToolTip(`Tycho: ${usd(o.costToday)} today (API-equivalent), ${o.liveCount} running`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `${usd(o.costToday)} today · ${usd(o.cost7d)} this week`, enabled: false },
        { type: 'separator' },
        live.length
          ? { label: `${o.liveCount} running`, enabled: false }
          : { label: 'Nothing running', enabled: false },
        ...live.map((s) => ({
          // No usage recorded is not $0.
          label: `${s.title.slice(0, 48)}  ${s.costSource === null ? '—' : `${s.costSource === 'estimated' ? '~' : ''}${usd(s.costUsd)}`}`,
          sublabel: s.projectPath?.split('/').pop(),
          click: () => actions.openSession(s.id),
        })),
        { type: 'separator' },
        { label: 'Open Tycho', accelerator: 'CommandOrControl+O', click: actions.open },
        { role: 'quit', label: 'Quit Tycho' },
      ]),
    );
  };
  refresh();
  return refresh;
}
