import { getAIRequestSignal } from './requestBudget';

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
