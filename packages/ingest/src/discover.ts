import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AdapterSpec } from '@tycho/adapters';

export function expand(p: string, env: NodeJS.ProcessEnv = process.env): string {
  return p.replace(/^~(?=$|\/)/, os.homedir()).replace(/\$(\w+)/g, (_, k: string) => env[k] ?? '');
}

/** Existing roots for this spec on this machine. An env override replaces the defaults. */
export function rootsFor(spec: AdapterSpec, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const override = spec.discover.env;
  const fromEnv = override && env[override.name];
  const list = fromEnv && override
    ? fromEnv.split(',').flatMap((d) => [override.suffix].flat().map((suffix) => path.join(expand(d.trim(), env), suffix)))
    : (spec.discover.roots[platform] ?? spec.discover.roots.default ?? [])
        // A root that names an unset variable does not apply on this machine.
        .filter((r) => [...r.matchAll(/\$(\w+)/g)].every(([, k]) => env[k!]))
        .map((r) => expand(r, env));
  return [...new Set(list)].filter((r) => existsSync(r) && statSync(r).isDirectory());
}

export interface Source {
  file: string;
  root: string;
}

/** Walk each root and return files the spec claims. Unreadable directories are skipped, never fatal. */
export function discover(spec: AdapterSpec, roots = rootsFor(spec)): Source[] {
  const out: Source[] = [];
  const walk = (root: string, dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(root, full, depth + 1);
      else if (e.isFile() && spec.discover.match(path.relative(root, full))) out.push({ file: full, root });
    }
  };
  for (const r of roots) walk(r, r, 0);
  return out;
}
