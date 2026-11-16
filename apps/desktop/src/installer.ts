import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { UpdateProgress } from '@tycho/core';
import { RELEASES_REPO } from './updates';

const exec = promisify(execFile);

export interface Asset {
  name: string;
  url: string;
  size: number;
}

/** Downloads are only ever taken from this repository's own release assets. */
export const isAssetUrl = (url: string) => url.startsWith(`https://github.com/${RELEASES_REPO}/releases/download/`);

/** The macOS build for this machine and the checksum list published next to it. */
export function pickAssets(assets: Asset[], arch: string): { zip: Asset; sums: Asset } | null {
  const zip = assets.find((a) => new RegExp(`^Tycho-darwin-${arch}-[\\w.+-]+\\.zip$`).test(a.name));
  const sums = assets.find((a) => a.name === 'SHA256SUMS.txt');
  return zip && sums && isAssetUrl(zip.url) && isAssetUrl(sums.url) ? { zip, sums } : null;
}

/** The hash `sha256sum` recorded for one file, from the text of SHA256SUMS.txt. */
export function expectedSha(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2] === name) return m[1]!.toLowerCase();
  }
  return null;
}

/**
 * Why this copy of the app cannot replace itself, or null when it can.
 * `appPath` is the .app bundle the running process was started from.
 */
export function installBlocker(o: { platform: string; packaged: boolean; appPath: string }): string | null {
  if (o.platform !== 'darwin') return 'Installing from inside the app is only available on macOS for now.';
  if (!o.packaged || !o.appPath.endsWith('.app')) return 'This copy is running from source, so there is no installed app to replace.';
  // macOS runs an app straight out of a download from a hidden read-only copy; that copy cannot be updated.
  if (o.appPath.includes('/AppTranslocation/')) return 'Move Tycho to your Applications folder and open it from there to install updates.';
  try {
    accessSync(o.appPath, constants.W_OK);
    accessSync(path.dirname(o.appPath), constants.W_OK);
  } catch {
    return `Tycho can't write to ${path.dirname(o.appPath)}, so it can't replace itself there.`;
  }
  return null;
}

/**
 * Runs after the app has quit: waits for it to be gone, puts the new bundle in its place and starts it.
 * The old bundle is kept aside until the new one is in position, and put back if the move fails.
 * Arguments: pid, installed app, new app, staging directory to delete, log file, "1" to relaunch.
 */
export const SWAP_SCRIPT = `
pid="$1"; app="$2"; new="$3"; stage="$4"; log="$5"; relaunch="$6"
say() { echo "$(date -u +%FT%TZ) $1" >> "$log"; }
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i+1)); done
if kill -0 "$pid" 2>/dev/null; then say "Tycho did not quit; nothing was changed"; exit 1; fi
sleep 0.3
old="$app.previous"
rm -rf "$old"
if ! mv "$app" "$old"; then say "could not move the installed app aside; nothing was changed"; exit 1; fi
if mv "$new" "$app"; then
  rm -rf "$old"
  say "installed $app"
else
  mv "$old" "$app"
  say "could not move the new app into place; the previous version was put back"
fi
rm -rf "$stage"
if [ "$relaunch" = 1 ]; then open "$app"; fi
`;

async function plist(app: string, key: string): Promise<string> {
  const { stdout } = await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
  return stdout.trim();
}

export interface InstallOptions {
  /** The installed .app bundle to replace. */
  appPath: string;
  /** The process that must exit before the swap happens. */
  pid: number;
  /** The version being installed, as the release names it (no leading v). */
  version: string;
  zip: Asset;
  sums: Asset;
  /** Scratch space for the download and the unpacked app; emptied first and removed afterwards. */
  workDir: string;
  logFile: string;
  relaunch?: boolean;
  fetcher?: typeof fetch;
  onProgress?: (p: UpdateProgress) => void;
}

/**
 * Download the release, check it against the published checksum, unpack it, and hand over to a small
 * script that swaps the bundles once this process has exited. Resolves when the script is waiting:
 * the caller's next step is to quit. Throws with a message fit to show the user; until the script runs,
 * the installed app has not been touched.
 */
export async function prepareInstall(o: InstallOptions): Promise<void> {
  const fetcher = o.fetcher ?? fetch;
  const progress = o.onProgress ?? (() => {});
  rmSync(o.workDir, { recursive: true, force: true });
  mkdirSync(o.workDir, { recursive: true });
  try {
    progress({ phase: 'downloading', received: 0, total: o.zip.size });
    const sumsRes = await fetcher(o.sums.url, { signal: AbortSignal.timeout(30_000) });
    if (!sumsRes.ok) throw new Error(`Could not download the checksum list (${sumsRes.status}).`);
    const want = expectedSha(await sumsRes.text(), o.zip.name);
    if (!want) throw new Error(`The release has no checksum for ${o.zip.name}, so the download can't be verified.`);

    const res = await fetcher(o.zip.url);
    if (!res.ok || !res.body) throw new Error(`Could not download ${o.zip.name} (${res.status}).`);
    const file = path.join(o.workDir, 'update.zip');
    const hash = createHash('sha256');
    const out = createWriteStream(file);
    let received = 0;
    let shown = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      received += chunk.byteLength;
      // A progress message per megabyte is plenty.
      if (received - shown >= 1_000_000) {
        shown = received;
        progress({ phase: 'downloading', received, total: o.zip.size });
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));

    progress({ phase: 'verifying', received, total: o.zip.size });
    if (hash.digest('hex') !== want) throw new Error('The download does not match its published checksum. Nothing was installed.');

    const unpacked = path.join(o.workDir, 'app');
    await exec('/usr/bin/ditto', ['-x', '-k', file, unpacked]);
    const next = path.join(unpacked, path.basename(o.appPath));
    if (!existsSync(next)) throw new Error(`The download does not contain ${path.basename(o.appPath)}.`);
    // The right app, and the version the release claims to be.
    const [id, currentId, version] = await Promise.all([plist(next, 'CFBundleIdentifier'), plist(o.appPath, 'CFBundleIdentifier'), plist(next, 'CFBundleShortVersionString')]);
    if (id !== currentId) throw new Error('The download is not Tycho. Nothing was installed.');
    if (version !== o.version) throw new Error(`The download is version ${version}, not ${o.version}. Nothing was installed.`);
    // Downloaded by Tycho itself, so normally not quarantined; clear the flag anyway so the new app opens without a prompt.
    await exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', next]).catch(() => {});

    progress({ phase: 'installing', received, total: o.zip.size });
    const child = spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'tycho-update', String(o.pid), o.appPath, next, o.workDir, o.logFile, o.relaunch === false ? '0' : '1'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (e) {
    rmSync(o.workDir, { recursive: true, force: true });
    throw e instanceof Error && e.name !== 'TimeoutError' && !/fetch failed/i.test(e.message) ? e : new Error('The download failed. Check your connection and try again.');
  }
}
