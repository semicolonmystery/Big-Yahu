// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useJobPolling } from '../../src/client/lib/useJobPolling';

interface Status { status: string; copied: number }

const isRunning = (value: Status) => value.status === 'running';

function Panel({ load }: { load: () => Promise<Status> }) {
  const { value, error, refresh } = useJobPolling(load, isRunning, 1000);
  return (
    <div>
      <span data-testid="state">{error ?? (value ? `${value.status} ${value.copied}` : 'loading')}</span>
      <button type="button" onClick={() => void refresh()}>refresh</button>
    </div>
  );
}

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const tick = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); });

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('watching a long job', () => {
  it('keeps asking while it is running, and the count climbs', async () => {
    vi.useFakeTimers();
    let copied = 0;
    const load = vi.fn(async () => ({ status: 'running', copied: (copied += 10) }));
    render(<Panel load={load} />);
    await settle();
    expect(screen.getByTestId('state').textContent).toBe('running 10');

    await tick(1000);
    expect(screen.getByTestId('state').textContent).toBe('running 20');
    await tick(1000);
    expect(screen.getByTestId('state').textContent).toBe('running 30');
  });

  it('stops once the job is finished', async () => {
    vi.useFakeTimers();
    const load = vi.fn()
      .mockResolvedValueOnce({ status: 'running', copied: 1 })
      .mockResolvedValue({ status: 'complete', copied: 2 });
    render(<Panel load={load} />);
    await settle();
    await tick(1000);
    expect(screen.getByTestId('state').textContent).toBe('complete 2');

    const settled = load.mock.calls.length;
    await tick(5000);
    // An idle panel asking every second forever is the other failure.
    expect(load).toHaveBeenCalledTimes(settled);
  });

  // The bug this replaced: the panel scheduled one deferred read after a button
  // and never rescheduled, so a job that had just started showed its first frame
  // and then sat there looking stuck.
  it('starts polling again when a button reports the job has begun', async () => {
    vi.useFakeTimers();
    const load = vi.fn()
      .mockResolvedValueOnce({ status: 'idle', copied: 0 })
      .mockResolvedValue({ status: 'running', copied: 5 });
    render(<Panel load={load} />);
    await settle();
    expect(screen.getByTestId('state').textContent).toBe('idle 0');

    // Nothing was moving, so nothing was being polled.
    await tick(3000);
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => { screen.getByText('refresh').click(); await Promise.resolve(); });
    expect(screen.getByTestId('state').textContent).toBe('running 5');
    await tick(1000);
    expect(load.mock.calls.length).toBeGreaterThan(2);
  });

  it('reports a failure instead of a status, and recovers on the next read', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('Could not reach the fact store'))
      .mockResolvedValue({ status: 'running', copied: 1 });
    render(<Panel load={load} />);
    await settle();
    expect(screen.getByTestId('state').textContent).toBe('Could not reach the fact store');

    await act(async () => { screen.getByText('refresh').click(); await Promise.resolve(); });
    expect(screen.getByTestId('state').textContent).toBe('running 1');
  });
});
