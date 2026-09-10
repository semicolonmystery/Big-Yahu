import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

const state = vi.hoisted(() => ({
  list: vi.fn(() => [{ channelId: 'channel', guildId: 'guild' }]),
  extract: vi.fn(async () => 1),
}));
vi.mock('../../src/server/ai/factExtraction', () => ({ runExtractionForChannel: state.extract }));
vi.mock('../../src/server/db/repositories/checkpointRepo', () => ({ listCheckpoints: state.list }));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({ getSettings: () => ({ checkIntervalMinutes: 1 }) }));
vi.mock('../../src/server/env', () => ({ isServedGuild: () => true }));
vi.mock('../../src/server/db/repositories/channelSettingsRepo', () => ({ canExtractFrom: () => true }));

import { runCheckNow, startScheduler, stopScheduler } from '../../src/server/scheduler/hourlyCheck';

const client = {
  channels: { fetch: async () => ({ id: 'channel', isTextBased: () => true }) },
} as unknown as Client;

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(async () => { await stopScheduler(); vi.useRealTimers(); });

describe('extraction scheduler', () => {
  it('reschedules after a failure outside the individual channel handler', async () => {
    state.list.mockImplementationOnce(() => { throw new Error('database busy'); });
    startScheduler(client);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.extract).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.extract).toHaveBeenCalledTimes(1);
  });

  it('stops future ticks and waits for an active manual extraction', async () => {
    let finish!: (count: number) => void;
    let signalStarted!: () => void;
    const completion = new Promise<number>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    state.extract.mockImplementationOnce(() => { signalStarted(); return completion; });
    startScheduler(client);
    const running = runCheckNow(client);
    await started;
    expect(await runCheckNow(client)).toBe(0);

    let stopped = false;
    const stopping = stopScheduler().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish(3);
    await stopping;
    expect(await running).toBe(3);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(state.extract).toHaveBeenCalledTimes(1);
  });
});
