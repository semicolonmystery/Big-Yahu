import { recordUsage } from '../db/repositories/usageRepo';

/**
 * OpenRouter's usage block. It is OpenAI's shape plus `cost`, the amount the
 * account was actually charged in US dollars, with peak pricing and cache
 * discounts already applied — so nothing here multiplies tokens by a price
 * table that could drift from the bill.
 */
interface OpenRouterUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  cost?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
  completion_tokens_details?: { reasoning_tokens?: unknown } | null;
}

export interface CallRecord {
  task: string;
  model: string;
  startedAt: number;
  /** The response body, or nothing when the call failed before one arrived. */
  response?: { usage?: unknown; provider?: unknown } | null;
  outcome: 'ok' | 'error';
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Records one model call and prints one line about it. Never throws: a reply
 * that worked must not fail because the bookkeeping behind it did.
 */
export function recordCall(record: CallRecord): void {
  const usage = (record.response?.usage ?? {}) as OpenRouterUsage;
  const provider = typeof record.response?.provider === 'string' ? record.response.provider : null;
  const row = {
    at: Date.now(),
    task: record.task,
    model: record.model,
    provider,
    promptTokens: count(usage.prompt_tokens),
    cachedTokens: count(usage.prompt_tokens_details?.cached_tokens),
    completionTokens: count(usage.completion_tokens),
    reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens),
    cost: count(usage.cost),
    latencyMs: Math.max(0, Date.now() - record.startedAt),
    outcome: record.outcome,
  };

  try {
    recordUsage(row);
  } catch (error) {
    console.error('[ai] could not record usage:', error);
  }

  console.log(
    `[ai] ${row.task} ${row.model}${provider ? ` via ${provider}` : ''}: `
      + `${row.promptTokens} in (${row.cachedTokens} cached) / ${row.completionTokens} out`
      + (row.reasoningTokens ? ` (${row.reasoningTokens} reasoning)` : '')
      + `, $${row.cost.toFixed(6)}, ${row.latencyMs}ms`
      + (row.outcome === 'ok' ? '' : `, ${row.outcome}`),
  );
}
