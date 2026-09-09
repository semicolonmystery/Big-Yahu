import { ApiError } from '@google/genai';
import { RETRYABLE_STATUSES } from '@shared/constants';
import { getAIRequestSignal } from './requestBudget';

export function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) return RETRYABLE_STATUSES.has(error.status);
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|fetch failed|ECONNRESET|ETIMEDOUT/i.test(text);
}

export function retryDelay(ms: number, pass: number, callerSignal?: AbortSignal): Promise<void> {
  const deadline = getAIRequestSignal();
  const signal = deadline && callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline ?? callerSignal;
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.min(60_000, ms * 2 ** pass));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
