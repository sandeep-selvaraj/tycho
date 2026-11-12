export const usd = (n: number) => `$${n.toFixed(2)}`;
export const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

export const HARNESS: Record<string, { label: string; color: string }> = {
  'claude-code': { label: 'Claude', color: 'var(--claude)' },
  opencode: { label: 'OpenCode', color: 'var(--opencode)' },
  cursor: { label: 'Cursor', color: 'var(--cursor)' },
  codex: { label: 'Codex', color: 'var(--codex)' },
};
export const harness = (h: string) => HARNESS[h] ?? { label: h, color: 'var(--fg-3)' };

export const STAMP = {
  reported: { code: 'R', title: 'Reported by the harness' },
  computed: { code: 'C', title: 'Computed from the price table' },
  estimated: { code: 'E', title: 'Estimated' },
} as const;

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
/** "14:02–14:39" today, "Nov 9, 14:02–14:39" another day, "Nov 9 19:21 – Nov 10 17:23" across days. */
export const span = (a: string, b: string) => {
  const s = new Date(a);
  const e = new Date(b);
  if (!sameDay(s, e)) return `${day.format(s)} ${time.format(s)} – ${day.format(e)} ${time.format(e)}`;
  const t = `${time.format(s)}–${time.format(e)}`;
  return sameDay(s, new Date()) ? t : `${day.format(s)}, ${t}`;
};

/** Harnesses whose cost is never exact. Shown with an "approximate" note wherever their cost appears. */
export const APPROXIMATE: Record<string, string> = {
  cursor: 'Cursor cost is approximate: model calls go through Cursor, which rarely records tokens. Shown only where tokens or Cursor’s own charge exist.',
};

/** Display a session's cost honestly: no data is not $0. */
export function costLabel(s: { costUsd: number; costSource: string | null; unpriced: boolean }): { text: string; title?: string } {
  if (s.costSource === null) return { text: '—', title: 'No token or cost data recorded for this session' };
  if (s.unpriced && s.costUsd === 0) return { text: 'unpriced', title: 'No price is known for this model' };
  const prefix = s.costSource === 'estimated' ? '~' : '';
  return { text: `${prefix}${usd(s.costUsd)}${s.unpriced ? '+' : ''}`, title: s.unpriced ? 'Some usage is from a model with no known price; this is a lower bound.' : undefined };
}
