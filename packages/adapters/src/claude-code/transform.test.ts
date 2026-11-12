import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NormalizedRecord } from '@tycho/core';
import { claudeCode } from './spec';
import { normalizeToolName, sessionFor } from './transform';

const root = path.join(__dirname, 'fixtures/projects');
const main = path.join(root, '-Users-dev-acme/sess-1.jsonl');
const sub = path.join(root, '-Users-dev-acme/sess-1/subagents/agent-abc.jsonl');

function run(file: string): NormalizedRecord[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        return claudeCode.transform(JSON.parse(line), { file, root });
      } catch {
        return []; // partial trailing line
      }
    });
}
const of = <K extends NormalizedRecord['kind']>(rs: NormalizedRecord[], k: K) => rs.filter((r): r is Extract<NormalizedRecord, { kind: K }> => r.kind === k);

describe('claude-code adapter', () => {
  const rs = run(main);

  it('matches session and subagent files only', () => {
    expect(claudeCode.discover.match(path.join('-Users-dev-acme', 'sess-1.jsonl'))).toBe(true);
    expect(claudeCode.discover.match(path.join('-Users-dev-acme', 'sess-1', 'subagents', 'agent-abc.jsonl'))).toBe(true);
    expect(claudeCode.discover.match(path.join('-Users-dev-acme', 'sess-1', 'tool-results', 'x.jsonl'))).toBe(false);
  });

  it('links subagent files to their parent session', () => {
    expect(sessionFor({ file: sub, root })).toEqual({ id: 'claude-code:sess-1/agent-abc', nativeId: 'sess-1/agent-abc', parentSessionId: 'claude-code:sess-1' });
    const subRecords = run(sub);
    expect(of(subRecords, 'usage')[0]).toMatchObject({ sessionId: 'claude-code:sess-1/agent-abc', model: 'claude-haiku-5-5' });
  });

  it('emits one usage id per API response so duplicates collapse', () => {
    const ids = of(rs, 'usage').map((u) => u.id);
    expect(ids).toEqual(['msg_1:req_1', 'msg_1:req_1', 'msg_2:req_2', 'msg_4']);
    expect(new Set(ids).size).toBe(3);
  });

  it('skips synthetic error messages from usage', () => {
    expect(of(rs, 'usage').some((u) => u.model === '<synthetic>')).toBe(false);
  });

  it('extracts tool calls with normalized names and joins results', () => {
    expect(of(rs, 'tool_call').map((t) => [t.id, t.name, t.nativeName])).toEqual([
      ['toolu_1', 'bash', 'Bash'],
      ['toolu_2', 'read_file', 'mcp__fs__Read_File'],
    ]);
    expect(of(rs, 'tool_result')).toMatchObject([
      { id: 'toolu_1', status: 'error', output: '1 failing', endedAt: '2026-11-01T10:00:09.000Z' },
      { id: 'toolu_2', status: 'ok', output: 'file body' },
    ]);
  });

  it('keeps prompts, drops meta lines, and files compaction summaries as system', () => {
    const msgs = of(rs, 'message');
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.id)).toEqual(['u1']);
    expect(msgs.find((m) => m.id === 'c1')?.role).toBe('system');
    expect(msgs.some((m) => m.id === 'meta1' || m.id === 'u2')).toBe(false);
  });

  it('proposes titles with rank: first prompt < ai title', () => {
    const titles = of(rs, 'session').flatMap((s) => (s.title ? [s.title] : []));
    expect(titles).toEqual([
      { text: 'Fix the flaky login test', rank: 1 },
      { text: 'Fix flaky login test', rank: 2 },
    ]);
  });

  it('normalizes tool names', () => {
    expect(normalizeToolName('mcp__claude-in-chrome__navigate')).toBe('navigate');
    expect(normalizeToolName('Edit')).toBe('edit');
  });
});

describe('claude-code activity and fallback titles', () => {
  const ctx = { file: main, root };
  const line = (o: object) => claudeCode.transform({ uuid: 'x', sessionId: 'sess-1', timestamp: '2026-11-01T10:00:00.000Z', ...o }, ctx);
  const session = (o: object) => of(line(o), 'session')[0];
  const user = (content: unknown) => session({ type: 'user', message: { role: 'user', content } });

  it('titles a session of only slash commands after the command', () => {
    expect(user('<command-name>/plugin</command-name>\n<command-message>plugin</command-message>\n<command-args>marketplace add x/y</command-args>')?.title)
      .toEqual({ text: '/plugin marketplace add x/y', rank: 0 });
    expect(user('<local-command-stdout>done</local-command-stdout>')?.title).toBeUndefined();
  });
});
