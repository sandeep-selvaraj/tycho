import { useState } from 'react';
import type { CostGranularity, CostPeriod } from '@tycho/core';
import { useTycho } from './useQuery';
import { HARNESS, STAMP, costLabel, harness, span, tokens, usd } from './format';
import { HarnessPicker } from './Range';

const BY: { by: CostGranularity; label: string }[] = [
  { by: 'day', label: 'Day' },
  { by: 'month', label: 'Month' },
  { by: 'year', label: 'Year' },
];

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const pad = (n: number) => String(n).padStart(2, '0');

/** The key of the period that contains today, in local time: the same calendar the queries group by. */
function current(by: CostGranularity): string {
  const d = new Date();
  const parts = [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())];
  return parts.slice(0, by === 'year' ? 1 : by === 'month' ? 2 : 3).join('-');
}

function periodLabel(by: CostGranularity, period: string): string {
  const [y, m = 1, d = 1] = period.split('-').map(Number) as [number, number?, number?];
  if (by === 'year') return period;
  if (by === 'month') return monthFmt.format(new Date(y, m - 1, 1));
  return period === current('day') ? 'Today' : dayFmt.format(new Date(y, m - 1, d));
}

const WEEKS = 53;
const CELL = 11;
const STEP = 14;
const LEFT = 30;
const TOP = 18;
const monthShort = new Intl.DateTimeFormat(undefined, { month: 'short' });
const weekdayShort = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** One colour for a day: each harness's colour, weighted by its share of that day's cost. */
function blend(byHarness: CostPeriod['byHarness']): string {
  const parts = byHarness.filter((x) => x.costUsd > 0);
  // Usage with no known price still happened; colour it by who was used, evenly.
  const list = parts.length ? parts : byHarness.map((x) => ({ ...x, costUsd: 1 }));
  let mix = '';
  let weight = 0;
  for (const x of list) {
    const c = harness(x.harness).color;
    mix = mix ? `color-mix(in oklab, ${mix} ${((weight / (weight + x.costUsd)) * 100).toFixed(1)}%, ${c})` : c;
    weight += x.costUsd;
  }
  return mix || 'var(--fg-3)';
}

const LEVELS = [0.3, 0.5, 0.75, 1];

/**
 * A year of days, one square each, in the manner of a contribution graph. Brightness says how much
 * was spent that day; hue says which harnesses it went to, blended when more than one was used.
 */
function Heatmap({ days, selected, onPick }: { days: CostPeriod[]; selected?: string; onPick: (day: string) => void }) {
  const byDay = new Map(days.map((d) => [d.period, d]));
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  // Weeks run Monday to Sunday; the last column is the current week.
  const start = new Date(today);
  start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - (WEEKS - 1) * 7);
  const cells = Array.from({ length: WEEKS * 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return { d, k: key(d), week: Math.floor(i / 7), row: i % 7 };
  }).filter((c) => c.d <= today);
  // Four brightness steps, split at the quartiles of the days that cost anything.
  const costs = cells.map((c) => byDay.get(c.k)?.costUsd ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const level = (n: number) => LEVELS[Math.min(3, Math.floor((costs.filter((c) => c < n).length / Math.max(1, costs.length)) * 4))]!;
  const months = cells.filter((c) => c.row === 0 && c.d.getDate() <= 7);
  const W = LEFT + WEEKS * STEP;
  return (
    <div className="heat">
      <svg viewBox={`0 0 ${W} ${TOP + 7 * STEP}`} role="group" aria-label="Cost per day over the last year, coloured by harness">
        {months.map((c) => (
          <text key={c.k} x={LEFT + c.week * STEP} y={10}>{monthShort.format(c.d)}</text>
        ))}
        {[0, 2, 4].map((row) => (
          <text key={row} x={0} y={TOP + row * STEP + 9}>{weekdayShort.format(new Date(2024, 0, 1 + row))}</text>
        ))}
        {cells.map((c) => {
          const p = byDay.get(c.k);
          const on = selected !== undefined && c.k.startsWith(selected);
          const label = `${dayFmt.format(c.d)} · ${p ? `${total(p)} · ${p.byHarness.map((x) => `${harness(x.harness).label} ${usd(x.costUsd)}`).join(', ')}` : 'no usage'}`;
          return (
            <rect
              key={c.k}
              className={on ? 'on' : undefined}
              x={LEFT + c.week * STEP}
              y={TOP + c.row * STEP}
              width={CELL}
              height={CELL}
              rx={2.5}
              fill={p ? blend(p.byHarness) : 'var(--raise)'}
              fillOpacity={p ? (p.costUsd > 0 ? level(p.costUsd) : LEVELS[0]) : 1}
              onClick={() => onPick(c.k)}
            >
              <title>{label}</title>
            </rect>
          );
        })}
      </svg>
      <div className="heat-key">
        <span>Colour shows the harness; days that used several are blended.</span>
        <span className="scale" aria-hidden="true">
          Less
          <i style={{ background: 'var(--raise)' }} />
          {LEVELS.map((o) => <i key={o} style={{ background: 'var(--fg-2)', opacity: o }} />)}
          More
        </span>
      </div>
    </div>
  );
}

/** A period total, marked when it is approximate or a lower bound, like every other cost in the app. */
function total(p: Pick<CostPeriod, 'costUsd' | 'estimated' | 'unpriced'>): string {
  return `${p.estimated ? '~' : ''}${usd(p.costUsd)}${p.unpriced ? '+' : ''}`;
}

export function Costs({ onOpen }: { onOpen: (id: string) => void }) {
  const [by, setBy] = useState<CostGranularity>('day');
  const [h, setH] = useState<string>();
  const [picked, setPicked] = useState<string>();
  const { data: periods } = useTycho(() => window.tycho.costPeriods({ by, harness: h }), [by, h]);
  // Until a period is picked, show the newest one with any usage.
  const period = picked ?? periods?.[0]?.period;
  const { data: rows } = useTycho(
    () => (period ? window.tycho.costSessions({ by, harness: h, period }) : Promise.resolve([])),
    [by, h, period],
  );
  // The graph always shows days, whatever the list on the left is grouped by.
  const { data: days } = useTycho(() => window.tycho.costPeriods({ by: 'day', harness: h }), [h]);
  const selected = periods?.find((p) => p.period === period);
  const max = Math.max(0.01, ...(periods ?? []).map((p) => p.costUsd));
  const sum = (rows ?? []).reduce((a, r) => a + r.costUsd, 0);

  return (
    <>
      <h1>Costs</h1>
      <p className="sub">API-equivalent cost by day, month or year. Pick a period to see which sessions it came from.</p>
      <div className="toolbar">
        <div className="filters" role="group" aria-label="Group by">
          {BY.map((b) => (
            <button
              key={b.by}
              aria-pressed={by === b.by}
              onClick={() => {
                setBy(b.by);
                setPicked(undefined);
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
        <HarnessPicker value={h} onChange={setH} options={Object.entries(HARNESS).map(([k, v]) => [k, v.label])} />
      </div>
      {periods && periods.length === 0 ? (
        <div className="empty">No usage recorded{h ? ` for ${harness(h).label}` : ''} yet.</div>
      ) : (
        <div className="costs">
          <div className="periods" role="group" aria-label="Periods">
            {(periods ?? []).map((p) => (
              <button key={p.period} className="period" aria-pressed={p.period === period} onClick={() => setPicked(p.period)}>
                <span>{periodLabel(by, p.period)}</span>
                <b>{total(p)}</b>
                <span className="split" aria-hidden="true">
                  {p.byHarness.map((x) => (
                    <i key={x.harness} style={{ width: `${(x.costUsd / max) * 100}%`, background: harness(x.harness).color }} />
                  ))}
                </span>
              </button>
            ))}
          </div>
          <div>
            <Heatmap
              days={days ?? []}
              selected={period}
              onPick={(day) => {
                setBy('day');
                setPicked(day);
              }}
            />
            {period && (
              <h2>
                {periodLabel(by, period)}
                {selected
                  ? ` · ${total(selected)} · ${selected.sessions} session${selected.sessions === 1 ? '' : 's'} · ${tokens(selected.tokens)} tokens`
                  : ' · no usage'}
              </h2>
            )}
            {rows && rows.length === 0 ? (
              <div className="empty">Nothing was spent in this period.</div>
            ) : (
              <table className="spend">
                <thead>
                  <tr><th>Session</th><th className="n">Tokens</th><th className="n">Share</th><th className="n">Cost</th></tr>
                </thead>
                <tbody>
                  {(rows ?? []).map((r) => {
                    const hs = harness(r.harness);
                    const stamp = STAMP[r.costSource];
                    const label = costLabel(r);
                    const share = sum > 0 ? r.costUsd / sum : 0;
                    return (
                      <tr key={r.id}>
                        <td>
                          <button className="open" onClick={() => onOpen(r.id)}>
                            <span className="chip" style={{ ['--c' as string]: hs.color }}>{hs.label}</span>
                            <b>{r.title}</b>
                          </button>
                          <div className="meta">
                            {[r.projectPath?.split('/').pop(), r.models.join(', '), r.firstAt === r.lastAt ? null : span(r.firstAt, r.lastAt)].filter(Boolean).join(' · ')}
                          </div>
                        </td>
                        <td className="n">{tokens(r.tokens)}</td>
                        <td className="n">
                          <span className="inline-bar"><i style={{ width: `${share * 100}%` }} /></span>
                          {share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`}
                        </td>
                        <td className="n">
                          <span className="cost">
                            <span className="fig" title={label.title}>{label.text}</span>
                            <span className={`stamp ${stamp.code}`} title={stamp.title}>{stamp.code}</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </>
  );
}
