import path from 'node:path';
import type { AdapterSpec } from '../types';
import { createJsonlTransform } from './transform';

export const codex = {
  harness: 'codex',
  displayName: 'Codex',
  discover: {
    roots: { default: ['~/.codex/sessions', '~/.codex/archived_sessions'] },
    env: { name: 'CODEX_HOME', suffix: ['sessions', 'archived_sessions'] },
    match: (rel) => /^rollout-.+\.jsonl$/.test(path.basename(rel)),
  },
  reader: 'jsonl',
  watch: { mode: 'append', debounceMs: 250 },
  createJsonlTransform,
} satisfies AdapterSpec;
