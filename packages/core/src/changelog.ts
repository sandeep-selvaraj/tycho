/**
 * Reads CHANGELOG.md, the single source for release notes: the GitHub Release body, the app's
 * "What's new" list and the update check all go through here.
 * Kept free of imports and of TypeScript-only syntax so plain Node can load it from the release scripts.
 */

export interface ReleaseNotes {
  /** `0.2.0`, or `Unreleased` for work that has not been cut into a release yet. */
  version: string;
  date: string | null;
  /** One plain-text line per change. */
  items: string[];
}

const HEADING = /^##\s+\[?(unreleased|v?\d+\.\d+\.\d+[\w.+-]*)\]?(?:\s+[-–—]\s+(\S+))?\s*$/i;

function sections(text: string): { version: string; date: string | null; body: string }[] {
  const out: { version: string; date: string | null; lines: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = HEADING.exec(line);
    if (m) out.push({ version: /^unreleased$/i.test(m[1]!) ? 'Unreleased' : m[1]!.replace(/^v/, ''), date: m[2] ?? null, lines: [] });
    else if (/^##\s/.test(line)) out.push({ version: '', date: null, lines: [] });
    else out[out.length - 1]?.lines.push(line);
  }
  return out.filter((s) => s.version).map((s) => ({ version: s.version, date: s.date, body: s.lines.join('\n').trim() }));
}

/** The changes in a piece of release-note markdown, one plain line each: bullets only, formatting removed. */
export function noteItems(markdown: string): string[] {
  const items: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) items.push(bullet[1]!);
    // An indented line continues the bullet above it.
    else if (/^\s+\S/.test(line) && items.length) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items
    .map((t) =>
      t
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|`)/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

/** Every release in the changelog, newest first as written. */
export function parseChangelog(text: string): ReleaseNotes[] {
  return sections(text).map((s) => ({ version: s.version, date: s.date, items: noteItems(s.body) }));
}

/** The markdown under one version's heading, or null when the changelog has no such section. */
export function releaseSection(text: string, version: string): string | null {
  const wanted = version.replace(/^v/, '').toLowerCase();
  return sections(text).find((s) => s.version.toLowerCase() === wanted)?.body ?? null;
}

/**
 * Orders two versions like `0.2.0` and `v0.10.1`: negative when `a` is older. A pre-release
 * (`1.0.0-beta.1`) sorts before the release it leads up to.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.trim().replace(/^v/, '').split('+')[0]!.split(/-(.*)/s);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? '' };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}
