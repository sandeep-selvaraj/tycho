import snapshot from './litellm-snapshot.json';

export interface Price {
  input_cost_per_token: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_1hr?: number;
}

export type PriceTable = Record<string, Price>;
export const BUNDLED_PRICES = snapshot as PriceTable;

const TIER = 200_000;
const PREFIXES = ['', 'anthropic/', 'openai/', 'gemini/', 'xai/', 'meta/', 'openrouter/'];

/**
 * Resolve a harness model id to a price-table key.
 * Tries exact, then provider-prefixed, then with date / version suffixes stripped
 * (`claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`, `foo[1m]` → `foo`).
 */
export function resolveModel(model: string, table: PriceTable = BUNDLED_PRICES, aliases: Record<string, string> = {}): string | undefined {
  const candidates = new Set<string>();
  const base = aliases[model] ?? model;
  const stripped = base.replace(/\[.*\]$/, '').replace(/(-(thinking|max|fast|high|medium|low))+$/, '');
  // Cursor style: claude-4.5-sonnet → claude-sonnet-4-5
  const reordered = stripped.replace(/^claude-(\d+)(?:\.(\d+))?-([a-z]+)$/, (_, a: string, b: string | undefined, fam: string) => `claude-${fam}-${a}${b ? `-${b}` : ''}`);
  for (const m of [base, stripped, reordered, stripped.replace(/-\d{8}$/, ''), stripped.replace(/@.*$/, ''), stripped.replace(/-latest$/, '')]) {
    for (const p of PREFIXES) candidates.add(p + m);
  }
  for (const c of candidates) if (table[c]) return c;
  return undefined;
}

function tiered(tokens: number, base = 0, above?: number): number {
  if (above === undefined || tokens <= TIER) return tokens * base;
  return TIER * base + (tokens - TIER) * above;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Portion of cacheWriteTokens written with a 1-hour TTL (priced higher than the 5-minute default). */
  cacheWrite1hTokens?: number;
}

/** API-equivalent USD cost, or undefined when the model has no known price. */
export function computeCost(model: string, t: TokenCounts, table: PriceTable = BUNDLED_PRICES, aliases?: Record<string, string>): number | undefined {
  const key = resolveModel(model, table, aliases);
  if (!key) return undefined;
  const p = table[key]!;
  return (
    tiered(t.inputTokens, p.input_cost_per_token, p.input_cost_per_token_above_200k_tokens) +
    tiered(t.outputTokens, p.output_cost_per_token, p.output_cost_per_token_above_200k_tokens) +
    tiered(t.cacheWriteTokens - (t.cacheWrite1hTokens ?? 0), p.cache_creation_input_token_cost, p.cache_creation_input_token_cost_above_200k_tokens) +
    (t.cacheWrite1hTokens ?? 0) * (p.cache_creation_input_token_cost_above_1hr ?? p.cache_creation_input_token_cost ?? 0) +
    tiered(t.cacheReadTokens, p.cache_read_input_token_cost, p.cache_read_input_token_cost_above_200k_tokens)
  );
}
