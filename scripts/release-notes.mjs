#!/usr/bin/env node
// Print one version's section of CHANGELOG.md, for the GitHub Release body.
//   node scripts/release-notes.mjs 0.2.0 [--repo owner/name --tag v0.2.0]
// With --repo and --tag, image paths inside the repository become links GitHub can show on the release page.
// Exits 1 when the version has no entry, which is what stops a release without notes.
import { readFileSync } from 'node:fs';
import { noteItems, releaseSection } from '../packages/core/src/changelog.ts';

const [version, ...rest] = process.argv.slice(2);
const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
if (!version) {
  console.error('Usage: node scripts/release-notes.mjs <version> [--repo owner/name --tag vX.Y.Z]');
  process.exit(2);
}
const section = releaseSection(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version);
if (!section || noteItems(section).length === 0) {
  console.error(`CHANGELOG.md has no entries for ${version}. Add a "## ${version.replace(/^v/, '')}" section listing what changed.`);
  process.exit(1);
}
const repo = opt('--repo');
const tag = opt('--tag');
const body = repo && tag
  ? section.replace(/(!\[[^\]]*\]\()(?!https?:|data:)\.?\/?([^)\s]+)/g, `$1https://raw.githubusercontent.com/${repo}/${tag}/$2`)
  : section;
console.log(body);
