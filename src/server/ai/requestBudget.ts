import { AsyncLocalStorage } from 'node:async_hooks';

export class AIRequestBudgetError extends Error {}
const budget = new AsyncLocalStorage<{ remaining: number; signal: AbortSignal }>();

/** Deadline for network work that does not consume a paid model attempt. */
export function getAIRequestSignal(): AbortSignal | undefined {
  return budget.getStore()?.signal;
}

/** Bounds total paid attempts, including retries/embeddings, for a single reply. */
export function withAIRequestBudget<T>(work: () => Promise<T>): Promise<T> {
  return budget.run({ remaining: 24, signal: AbortSignal.timeout(120_000) }, work);
}

export function claimAIRequest(): AbortSignal {
  const current = budget.getStore();
  if (current) {
    // Running out of time and running out of attempts are different failures,
    // and they shared one message: a reply killed by the deadline was logged as
    // having exhausted its budget, which sends anyone reading the log looking
    // in the wrong place.
    if (current.signal.aborted) {
      throw new AIRequestBudgetError('This reply ran out of time before the model answered');
    }
    if (current.remaining <= 0) {
      throw new AIRequestBudgetError('The model attempts allowed for one reply are exhausted');
    }
    // Only once the call is actually admitted, so a refusal leaves the count
    // describing what was really spent.
    current.remaining -= 1;
  }
  const timeout = AbortSignal.timeout(45_000);
  return current ? AbortSignal.any([current.signal, timeout]) : timeout;
}
