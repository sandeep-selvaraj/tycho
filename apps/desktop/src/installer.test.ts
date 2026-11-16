import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UpdateProgress } from '@tycho/core';
import { expectedSha, installBlocker, pickAssets, prepareInstall, type Asset } from './installer';

const base = 'https://github.com/sandeep-selvaraj/tycho/releases/download/v0.2.0/';
const asset = (name: string, size = 1): Asset => ({ name, url: base + name, size });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in .app: just enough of a bundle for the installer to recognise it. */
function fakeApp(dir: string, version: string, id = 'com.electron.tycho'): string {
  const app = path.join(dir, 'Tycho.app');
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  writeFileSync(path.join(app, 'Contents', 'MacOS', 'tycho'), `binary ${version}`);
  return app;
}

describe('installer', () => {
  it('picks the build for this Mac and reads its checksum', () => {
    const assets = [asset('Tycho-darwin-x64-0.2.0.zip'), asset('Tycho-darwin-arm64-0.2.0.zip'), asset('Tycho-Setup.exe'), asset('SHA256SUMS.txt')];
    expect(pickAssets(assets, 'arm64')?.zip.name).toBe('Tycho-darwin-arm64-0.2.0.zip');
    expect(pickAssets(assets.slice(0, 3), 'arm64')).toBeNull(); // no checksum list, no install
    expect(pickAssets([{ ...asset('Tycho-darwin-arm64-0.2.0.zip'), url: 'https://example.com/x.zip' }, asset('SHA256SUMS.txt')], 'arm64')).toBeNull();
    const sums = `${'a'.repeat(64)}  Tycho-darwin-x64-0.2.0.zip\n${'b'.repeat(64)} *Tycho-darwin-arm64-0.2.0.zip\n`;
    expect(expectedSha(sums, 'Tycho-darwin-arm64-0.2.0.zip')).toBe('b'.repeat(64));
    expect(expectedSha(sums, 'other.zip')).toBeNull();
  });

  it('explains when this copy cannot replace itself', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tycho-inst-'));
    const app = fakeApp(dir, '0.1.0');
    expect(installBlocker({ platform: 'darwin', packaged: true, appPath: app })).toBeNull();
    expect(installBlocker({ platform: 'win32', packaged: true, appPath: app })).toMatch(/macOS/);
    expect(installBlocker({ platform: 'darwin', packaged: false, appPath: app })).toMatch(/source/);
    expect(installBlocker({ platform: 'darwin', packaged: true, appPath: '/private/var/folders/x/AppTranslocation/y/d/Tycho.app' })).toMatch(/Applications/);
    expect(installBlocker({ platform: 'darwin', packaged: true, appPath: '/nonexistent/Tycho.app' })).toMatch(/can't write/);
  });

  // The real thing end to end, minus Electron: needs macOS's ditto and plutil.
  describe.runIf(process.platform === 'darwin')('on macOS', () => {
    function setup(newVersion: string, newId?: string) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tycho-inst-'));
      const installed = fakeApp(path.join(dir, 'Applications'), '0.1.0');
      const built = fakeApp(path.join(dir, 'build'), newVersion, newId);
      const zipFile = path.join(dir, 'Tycho-darwin-arm64-0.2.0.zip');
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', built, zipFile]);
      const zipBytes = readFileSync(zipFile);
      const zip = asset('Tycho-darwin-arm64-0.2.0.zip', zipBytes.length);
      const sums = asset('SHA256SUMS.txt');
      const sha = createHash('sha256').update(zipBytes).digest('hex');
      const serve = (sumsText: string) => (async (url: string) => (url === sums.url ? new Response(sumsText) : new Response(zipBytes))) as unknown as typeof fetch;
      const options = { appPath: installed, version: '0.2.0', zip, sums, workDir: path.join(dir, 'work'), logFile: path.join(dir, 'install.log'), relaunch: false };
      return { dir, installed, zip, sha, serve, options };
    }
    const binary = (app: string) => readFileSync(path.join(app, 'Contents', 'MacOS', 'tycho'), 'utf8');

    it('swaps in the new version once the running app has quit, and not before', async () => {
      const t = setup('0.2.0');
      const running = spawn('sleep', ['1.2']);
      const seen: UpdateProgress['phase'][] = [];
      await prepareInstall({ ...t.options, pid: running.pid!, fetcher: t.serve(`${t.sha}  ${t.zip.name}\n`), onProgress: (p) => seen.push(p.phase) });
      expect([...new Set(seen)]).toEqual(['downloading', 'verifying', 'installing']);
      expect(binary(t.installed)).toBe('binary 0.1.0'); // still running: untouched
      await new Promise((r) => running.once('exit', r));
      for (let i = 0; i < 50 && binary(t.installed) !== 'binary 0.2.0'; i++) await sleep(100);
      expect(binary(t.installed)).toBe('binary 0.2.0');
      for (let i = 0; i < 20 && existsSync(t.options.workDir); i++) await sleep(100);
      expect(existsSync(`${t.installed}.previous`)).toBe(false);
      expect(existsSync(t.options.workDir)).toBe(false);
      expect(readFileSync(t.options.logFile, 'utf8')).toMatch(/installed /);
    });

    it('installs nothing when the download does not match its checksum', async () => {
      const t = setup('0.2.0');
      await expect(prepareInstall({ ...t.options, pid: process.pid, fetcher: t.serve(`${'0'.repeat(64)}  ${t.zip.name}\n`) })).rejects.toThrow(/checksum/);
      await expect(prepareInstall({ ...t.options, pid: process.pid, fetcher: t.serve('') })).rejects.toThrow(/no checksum/);
      expect(binary(t.installed)).toBe('binary 0.1.0');
      expect(existsSync(t.options.workDir)).toBe(false);
    });

    it('installs nothing when the download is a different app or version', async () => {
      const wrongVersion = setup('0.3.0');
      await expect(prepareInstall({ ...wrongVersion.options, pid: process.pid, fetcher: wrongVersion.serve(`${wrongVersion.sha}  ${wrongVersion.zip.name}\n`) })).rejects.toThrow(/version 0.3.0/);
      const wrongApp = setup('0.2.0', 'com.example.other');
      await expect(prepareInstall({ ...wrongApp.options, pid: process.pid, fetcher: wrongApp.serve(`${wrongApp.sha}  ${wrongApp.zip.name}\n`) })).rejects.toThrow(/not Tycho/);
      expect(binary(wrongApp.installed)).toBe('binary 0.1.0');
    });
  });
});
