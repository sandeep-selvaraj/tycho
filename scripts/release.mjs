#!/usr/bin/env node
// Cut a release:  npm run release -- 0.2.0
// Turns the changelog's "Unreleased" section into this version, bumps the app version, commits and tags.
// Nothing is pushed; pushing the tag is what starts the build (see .github/workflows/release.yml).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { noteItems, releaseSection } from '../packages/core/src/changelog.ts';

const root = new URL('..', import.meta.url);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) fail('Usage: npm run release -- <version>   e.g. npm run release -- 0.2.0');
const tag = `v${version}`;
if (run('git', ['status', '--porcelain'])) fail('Commit or stash your changes first: a release is cut from a clean tree.');
if (run('git', ['tag', '--list', tag])) fail(`Tag ${tag} already exists.`);

const file = new URL('CHANGELOG.md', root);
let changelog = readFileSync(file, 'utf8');
const has = (v) => noteItems(releaseSection(changelog, v) ?? '').length > 0;
if (!has(version)) {
  if (!has('Unreleased')) fail(`CHANGELOG.md has nothing to release. List what changed under "## Unreleased" (or "## ${version}") and run this again.`);
  const today = new Date().toISOString().slice(0, 10);
  changelog = changelog.replace(/^##[ \t]+\[?unreleased\]?[ \t]*$/im, `## ${version} - ${today}`);
  writeFileSync(file, changelog);
}

run('npm', ['version', version, '--workspace', '@tycho/desktop', '--no-git-tag-version']);
run('git', ['add', 'CHANGELOG.md', 'apps/desktop/package.json', 'package-lock.json']);
run('git', ['commit', '-m', `release: ${tag}`]);
run('git', ['tag', '-a', tag, '-m', `Tycho ${tag}`]);

console.log(`Tagged ${tag}. Release notes:\n`);
console.log(releaseSection(changelog, version));
console.log(`\nTo build installers and draft the GitHub Release:\n  git push origin ${run('git', ['branch', '--show-current'])} ${tag}`);
