import { useEffect, useState } from 'react';
import type { AppInfo, UpdateCheck, UpdateProgress } from '@tycho/core';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
/** Changelog dates are plain calendar days; show them as written, not shifted by a time zone. */
const day = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? dateFmt.format(new Date(`${d}T12:00:00`)) : d);

function Changes({ items }: { items: string[] }) {
  return <ul className="changes">{items.map((t) => <li key={t}>{t}</li>)}</ul>;
}

export function Settings({ info, check, checking, onCheck, onSettings }: {
  info: AppInfo | undefined;
  check: UpdateCheck | undefined;
  checking: boolean;
  onCheck: () => void;
  onSettings: (s: AppInfo['settings']) => void;
}) {
  const [older, setOlder] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  useEffect(() => window.tycho.onUpdateProgress(setProgress), []);
  const install = () => {
    setInstallError(null);
    setProgress({ phase: 'downloading', received: 0, total: 0 });
    // On success the app quits and restarts, so an answer only comes back when something went wrong.
    void window.tycho.installUpdate().then((r) => {
      if (!r.error) return;
      setProgress(null);
      setInstallError(r.error);
    });
  };
  const working = progress
    ? progress.phase === 'downloading'
      ? `Downloading${progress.total ? ` ${Math.min(99, Math.round((progress.received / progress.total) * 100))}%` : ''}…`
      : progress.phase === 'verifying'
        ? 'Verifying the download…'
        : 'Installing. Tycho will restart in a moment…'
    : null;
  if (!info) return null;
  // A build made from unreleased work lists that work too; a released build never has such a section.
  const [latest, ...rest] = info.releases;
  const status = checking
    ? 'Checking…'
    : !check
      ? 'Not checked yet.'
      : check.error
        ? check.error
        : check.available
          ? `Version ${check.latest!.version} is available.`
          : `You have the latest version. Checked at ${timeFmt.format(new Date(check.checkedAt))}.`;
  return (
    <div className="settings">
      <h1>Settings</h1>
      <p className="sub">The version you are running, and whether a newer one exists.</p>

      <h2>Version</h2>
      <div className="panel about">
        <div>
          <div className="ver">Tycho {info.version}</div>
          <div className={`small${check?.error && !checking ? ' err' : ''}`} role="status">{status}</div>
        </div>
        <button className="btn" onClick={onCheck} disabled={checking}>Check for updates</button>
      </div>

      {check?.available && check.latest && !checking && (
        <div className="panel update">
          <div className="about">
            <div>
              <div className="ver">New in {check.latest.version}</div>
              {check.latest.publishedAt && <div className="small">Released {dateFmt.format(new Date(check.latest.publishedAt))}</div>}
            </div>
            {check.install.possible ? (
              <button className="btn primary" onClick={install} disabled={progress !== null}>Install and restart</button>
            ) : (
              <button className="btn primary" onClick={() => void window.tycho.openUpdate()}>Get {check.latest.version}</button>
            )}
          </div>
          {check.latest.items.length > 0 && <Changes items={check.latest.items} />}
          {check.install.possible ? (
            <>
              <p className={`small${installError ? ' err' : ''}`} role="status">
                {working ?? installError ?? 'Downloads the new version, checks it against the checksum published with the release, replaces this app and reopens it.'}
              </p>
              {progress?.phase === 'downloading' && progress.total > 0 && (
                <div className="progress" aria-hidden="true"><i style={{ width: `${(progress.received / progress.total) * 100}%` }} /></div>
              )}
              {installError && <button className="back" onClick={() => void window.tycho.openUpdate()}>Download it from the release page instead</button>}
            </>
          ) : (
            <p className="small">{check.install.reason} This button opens the download page in your browser.</p>
          )}
        </div>
      )}

      <label className="toggle">
        <input
          type="checkbox"
          checked={info.settings.checkUpdatesOnLaunch}
          onChange={(e) => onSettings({ ...info.settings, checkUpdatesOnLaunch: e.target.checked })}
        />
        <span>
          Check for updates when Tycho starts
          <span className="small">
            Checking asks GitHub for the latest release and sends nothing about you or your sessions. When this is off, Tycho only checks when you press the button.
          </span>
        </span>
      </label>

      {latest && (
        <>
          <h2>What's new in {latest.version === 'Unreleased' ? 'this build (not released yet)' : latest.version}{latest.date ? ` · ${day(latest.date)}` : ''}</h2>
          <div className="panel"><Changes items={latest.items} /></div>
        </>
      )}
      {rest.length > 0 && (
        <>
          <button className="back" aria-expanded={older} onClick={() => setOlder(!older)}>{older ? 'Hide earlier releases' : `Show earlier releases (${rest.length})`}</button>
          {older && rest.map((r) => (
            <div key={r.version}>
              <h2>{r.version}{r.date ? ` · ${day(r.date)}` : ''}</h2>
              <div className="panel"><Changes items={r.items} /></div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
