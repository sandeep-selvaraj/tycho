import { z } from 'zod';

export const CostSource = z.enum(['reported', 'computed', 'estimated']);
export type CostSource = z.infer<typeof CostSource>;

export type Harness = 'claude-code' | 'opencode' | 'cursor' | 'codex' | (string & {});

export const Session = z.object({
  id: z.string(),
  harness: z.string(),
  nativeId: z.string(),
  projectPath: z.string().optional(),
  title: z.string().optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
  parentSessionId: z.string().optional(),
  sourceRef: z.string(),
});
export type Session = z.infer<typeof Session>;

export const Message = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  timestamp: z.string(),
  model: z.string().optional(),
  text: z.string().optional(),
  isSidechain: z.boolean().optional(),
});
export type Message = z.infer<typeof Message>;

export const ToolCall = z.object({
  id: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  name: z.string(),
  nativeName: z.string(),
  input: z.string().optional(),
  output: z.string().optional(),
  status: z.enum(['ok', 'error', 'pending', 'unknown']),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const UsageEvent = z.object({
  id: z.string(),
  sessionId: z.string(),
  messageId: z.string().optional(),
  timestamp: z.string(),
  provider: z.string().optional(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  cacheWrite1hTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().optional(),
  costSource: CostSource,
});
export type UsageEvent = z.infer<typeof UsageEvent>;
