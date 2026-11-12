import { useState } from 'react';
import type { OverviewData } from '@tycho/core';
import { useTycho } from './useQuery';
import { SessionList } from './SessionList';
import { APPROXIMATE, HARNESS, harness, tokens, usd } from './format';

function DailyChart({ daily }: { daily: OverviewData['daily'] }) {
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return d.toISOString().slice(0, 10);
  });
  const per = days.map((day) => daily.filter((r) => r.day === day));
  const max = Math.max(1, ...per.map((rows) => rows.reduce((a, r) => a + r.costUsd, 0)));
  const W = 360, H = 150, bw = W / 14;
  return (
    <svg viewBox="0 0 360 180" role="img" aria-label="Daily API-equivalent cost, stacked by harness">
      {per.map((rows, i) => {
        let y = H;
        return rows.map((r) => {
          const h = (r.costUsd / max) * H;
          y -= h;
          return <rect key={`${i}-${r.harness}`} x={i * bw + 3} y={y} width={bw - 6} height={h} fill={harness(r.harness).color} />;
        });
      })}
      <line x1={0} x2={W} y1={H} y2={H} stroke="var(--line)" />
      <text x={0} y={172} fill="var(--fg-3)" fontSize={10}>{days[0]}</text>
      <text x={W} y={172} textAnchor="end" fill="var(--fg-3)" fontSize={10}>Today</text>
      <text x={0} y={10} fill="var(--fg-3)" fontSize={10}>{usd(max)}</text>
    </svg>
  );
}

export function Overview({ onOpen }: { onOpen: (id: string) => void }) {
  const { data: ov } = useTycho(() => window.tycho.overview());
  const { data: rows = [] } = useTycho(() => window.tycho.sessions({ limit: 50 }));
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const running = rows.filter((r) => r.live);
  const today = rows.filter((r) => !r.live && new Date(r.updatedAt) >= startOfDay);
  const maxModel = Math.max(1, ...(ov?.byModel.map((m) => m.costUsd) ?? []));
  return (
    <div className="board">
      <div>
        <h2>Running</h2>
        <SessionList rows={running} onOpen={onOpen} empty="No agent is running right now." />
        <HarnessCompare />
        <h2>Earlier today</h2>
        <SessionList
          rows={today}
          onOpen={onOpen}
          empty={ov?.sessionCount ? 'Nothing else ran today.' : 'No sessions yet. Tycho is reading your harness history; this fills in as it goes.'}
        />
      </div>
      <div>
        <h2>Cost, last 14 days</h2>
        <div className="chart"><DailyChart daily={ov?.daily ?? []} /></div>
        <h2>By model, 30 days</h2>
        {ov && ov.byModel.length > 0 ? (
          <div className="models">
            {ov.byModel.map((m) => (
              <div key={`${m.model}-${m.harness}`}>
                <span>{m.model}</span>
                <span title={m.unpriced ? 'No price known for this model' : undefined}>{m.unpriced && m.costUsd === 0 ? 'unpriced' : usd(m.costUsd)}</span>
                <div className="m"><i style={{ width: `${(m.costUsd / maxModel) * 100}%`, background: harness(m.harness).color }} /></div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">No usage recorded yet.</div>
        )}
        <h2>Cache reads</h2>
        <div className="cache-line">
          {ov?.cacheReadShare == null ? '—' : `${Math.round(ov.cacheReadShare * 100)}%`}{' '}
          <span className="small">of input tokens came from cache</span>
        </div>
      </div>
    </div>
  );
}

function HarnessCompare() {
  const { data: rows = [] } = useTycho(() => window.tycho.harnesses({ days: 30 }));
  if (rows.length === 0) return null;
  return (
    <>
      <h2>By harness, 30 days</h2>
      <table className="compare">
        <thead>
          <tr><th>Harness</th><th className="n">Cost</th><th className="n">Sessions</th><th className="n">Per session</th><th className="n">Tokens</th><th className="n">Cache reads</th><th className="n">Tool errors</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.harness}>
              <td><span className="chip" style={{ ['--c' as string]: harness(r.harness).color }}>{harness(r.harness).label}</span></td>
              <td className="n" title={APPROXIMATE[r.harness]}>{APPROXIMATE[r.harness] ? '~' : ''}{usd(r.costUsd)}{APPROXIMATE[r.harness] && <span className="approx">approx.</span>}</td>
              <td className="n">{r.sessions}</td>
              <td className="n">{APPROXIMATE[r.harness] ? '~' : ''}{usd(r.costPerSession)}</td>
              <td className="n">{tokens(r.tokens)}</td>
              <td className="n">{r.cacheReadShare == null ? '—' : `${Math.round(r.cacheReadShare * 100)}%`}</td>
              <td className={`n${r.toolCalls && r.toolErrors / r.toolCalls >= 0.1 ? ' err' : ''}`}>
                {r.toolCalls ? `${((r.toolErrors / r.toolCalls) * 100).toFixed(1)}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function Sessions({ onOpen }: { onOpen: (id: string) => void }) {
  const [h, setH] = useState<string | undefined>();
  const { data: rows = [] } = useTycho(() => window.tycho.sessions({ harness: h }), [h]);
  return (
    <>
      <h1>Sessions</h1>
      <p className="sub">All sessions across harnesses, newest first.</p>
      <div className="filters" role="group" aria-label="Filter by harness">
        <button aria-pressed={!h} onClick={() => setH(undefined)}>All</button>
        {Object.entries(HARNESS).map(([k, v]) => (
          <button key={k} aria-pressed={h === k} onClick={() => setH(k)}>{v.label}</button>
        ))}
      </div>
      <SessionList rows={rows} onOpen={onOpen} empty="No sessions match." />
    </>
  );
}

export function Sources() {
  const { data: rows = [] } = useTycho(() => window.tycho.sources());
  return (
    <>
      <h1>Sources</h1>
      <p className="sub">Tycho only reads these. Nothing is installed in any harness.</p>
      {rows.length === 0 ? (
        <div className="empty"><b>No sources discovered yet</b>Tycho looks for local session history from Claude Code, OpenCode, Cursor, and Codex.</div>
      ) : (
        <table>
          <thead><tr><th>Harness</th><th>Path</th><th>Health</th><th>Last ingest</th><th className="n">Records</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sourceRef}>
                <td><span className="chip" style={{ ['--c' as string]: harness(r.harness).color }}>{harness(r.harness).label}</span></td>
                <td>
                  <code>{r.sourceRef}</code>
                  {APPROXIMATE[r.harness] && <div className="small">{APPROXIMATE[r.harness]}</div>}
                </td>
                <td><span className={`health${r.health === 'ok' ? '' : ' warn'}`}><i />{r.health === 'ok' ? 'Healthy' : r.lastError ?? r.health}</span></td>
                <td>{r.lastIngestAt ? new Date(r.lastIngestAt).toLocaleString() : '—'}</td>
                <td className="n">{r.records.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
