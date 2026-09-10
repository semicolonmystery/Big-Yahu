import { AsyncLocalStorage } from 'node:async_hooks';

export class AIRequestBudgetError extends Error {}
const budget = new AsyncLocalStorage<{ remaining: number; signal: AbortSignal }>();

/** Deadline for network work that does not consume a paid Gemini attempt. */
export function getAIRequestSignal(): AbortSignal | undefined {
  return budget.getStore()?.signal;
}

/** Bounds total paid attempts, including retries/embeddings, for a single reply. */
export function withAIRequestBudget<T>(work: () => Promise<T>): Promise<T> {
  return budget.run({ remaining: 24, signal: AbortSignal.timeout(120_000) }, work);
}

export function claimAIRequest(): AbortSignal {
  const current = budget.getStore();
  if (current && (current.remaining-- <= 0 || current.signal.aborted)) {
    throw new AIRequestBudgetError('The AI request budget for this reply is exhausted');
  }
  const timeout = AbortSignal.timeout(45_000);
  return current ? AbortSignal.any([current.signal, timeout]) : timeout;
}
