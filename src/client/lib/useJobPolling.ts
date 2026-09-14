import { useCallback, useEffect, useState } from 'react';

/**
 * Reads a long job's status, and keeps reading it while the job is running.
 *
 * The panels showing a re-embed and a cleanup both need the same thing: fetch
 * once, then poll while something is actually moving and stop when it is not.
 * Doing that with a self-rescheduling timer was subtly wrong — the chain ended
 * the moment the status was idle, and pressing **Start** never restarted it, so
 * a job that had just begun showed its first frame and then sat there looking
 * stuck.
 *
 * Polling is driven by the status instead. Whether the job is live is derived
 * from the value, and the effect that polls depends on it: the moment a fetch
 * (or a button) reports a running job the interval starts, and the moment one
 * reports a finished one it stops. There is nothing to restart by hand.
 */
export function useJobPolling<T>(
  load: () => Promise<T>,
  isLive: (value: T) => boolean,
  intervalMs = 2000,
): {
  value: T | null;
  error: string | null;
  /** Fetch now, outside the poll — what a button calls once its action returns. */
  refresh: () => Promise<void>;
} {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setValue(await load());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not read the status');
    }
  }, [load]);

  // Read once whenever what is being asked for changes — the cleanup panel's
  // count depends on which types are ticked, not only on the job. Cancelled on
  // the way out, so a slow answer to a question nobody is asking any more
  // cannot land on top of a newer one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await load();
        if (!cancelled) { setValue(next); setError(null); }
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Could not read the status');
      }
    })();
    return () => { cancelled = true; };
  }, [load]);

  const live = value !== null && isLive(value);
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => { void refresh(); }, intervalMs);
    return () => clearInterval(timer);
  }, [live, refresh, intervalMs]);

  return { value, error, refresh };
}
