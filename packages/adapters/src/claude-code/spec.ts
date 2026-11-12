import path from 'node:path';
import type { AdapterSpec } from '../types';
import { transform } from './transform';

export const claudeCode = {
  harness: 'claude-code',
  displayName: 'Claude Code',
  discover: {
    roots: { default: ['~/.claude/projects', '~/.config/claude/projects'] },
    env: { name: 'CLAUDE_CONFIG_DIR', suffix: 'projects' },
    // <encoded-cwd>/<session>.jsonl and <encoded-cwd>/<session>/subagents/agent-<id>.jsonl
    match: (rel) => {
      const parts = rel.split(path.sep);
      if (!rel.endsWith('.jsonl')) return false;
      return parts.length === 2 || (parts.length === 4 && parts[2] === 'subagents');
    },
  },
  reader: 'jsonl',
  watch: { mode: 'append', debounceMs: 250 },
  transform,
} satisfies AdapterSpec;
