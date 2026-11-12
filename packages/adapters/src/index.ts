export * from './types';
export { claudeCode } from './claude-code/spec';
export { opencode, opencodeJson } from './opencode/spec';
export { cursor } from './cursor/spec';
export { codex } from './codex/spec';
import { claudeCode } from './claude-code/spec';
import { opencode, opencodeJson } from './opencode/spec';
import { cursor } from './cursor/spec';
import { codex } from './codex/spec';
import type { AdapterSpec } from './types';

export const ADAPTERS: AdapterSpec[] = [claudeCode, opencode, opencodeJson, codex, cursor];
