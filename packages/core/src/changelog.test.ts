import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, noteItems, parseChangelog, releaseSection } from './changelog';

const SAMPLE = `# Changelog

Intro text with a list that is not a release:
- not a change

## Unreleased

- **Costs view.** See cost by day.
  It continues on a second line.
- Fixed a [bug](https://example.com/1) in \`watch.ts\`.

![Costs](docs/releases/costs.png)

## [0.2.0] - 2026-11-20

### Added
- Search.

## Notes

- not a release either

## v0.1.0

- First release.
`;

describe('changelog', () => {
  it('reads each release and its changes as plain lines', () => {
    expect(parseChangelog(SAMPLE)).toEqual([
      { version: 'Unreleased', date: null, items: ['Costs view. See cost by day. It continues on a second line.', 'Fixed a bug in watch.ts.'] },
      { version: '0.2.0', date: '2026-11-20', items: ['Search.'] },
      { version: '0.1.0', date: null, items: ['First release.'] },
    ]);
  });

  it('returns one release as markdown, images included, for the GitHub Release', () => {
    expect(releaseSection(SAMPLE, 'v0.2.0')).toBe('### Added\n- Search.');
    expect(releaseSection(SAMPLE, 'unreleased')).toContain('![Costs](docs/releases/costs.png)');
    expect(releaseSection(SAMPLE, '9.9.9')).toBeNull();
  });

  it('reads the notes GitHub sends back for a release', () => {
    expect(noteItems('- **Costs view.** New.\n\nUnsigned builds. Verify downloads.')).toEqual(['Costs view. New.']);
  });

  it('orders versions', () => {
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
  });

  it('keeps the real changelog readable: every release has at least one change', () => {
    const releases = parseChangelog(readFileSync(path.join(__dirname, '../../../CHANGELOG.md'), 'utf8'));
    expect(releases.length).toBeGreaterThan(0);
    for (const r of releases) expect(r.items.length, r.version).toBeGreaterThan(0);
  });
});
