import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  env: { discordToken: '', chromaHost: 'localhost', chromaPort: 8000 },
  get: vi.fn(), ready: vi.fn(),
}));
vi.mock('../../src/server/env', () => ({ env: state.env }));
vi.mock('../../src/server/db/client', () => ({ db: { get: state.get } }));
vi.mock('../../src/server/bot/client', () => ({ discordClient: { isReady: state.ready } }));

describe('readiness', () => {
  beforeEach(() => { vi.resetModules(); state.env.discordToken = ''; state.get.mockReset(); state.ready.mockReturnValue(true); });
  it('serves admin-only without Discord or Chroma dependencies', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { healthStatus } = await import('../../src/server/api/health');
    expect(await healthStatus()).toEqual({ ok: true, database: true, discord: true, chroma: true, mode: 'admin-only' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports failed database and Discord readiness', async () => {
    state.env.discordToken = 'test'; state.get.mockImplementation(() => { throw new Error('closed'); });
    state.ready.mockReturnValue(false); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    const { healthStatus } = await import('../../src/server/api/health');
    expect(await healthStatus()).toMatchObject({ ok: false, database: false, discord: false, chroma: true });
  });
  it('bounds Chroma checks and coalesces overlapping requests', async () => {
    state.env.discordToken = 'test';
    const fetch = vi.fn().mockRejectedValue(new Error('unavailable')); vi.stubGlobal('fetch', fetch);
    const { healthStatus } = await import('../../src/server/api/health');
    const results = await Promise.all([healthStatus(), healthStatus(), healthStatus()]);
    expect(results.every((result) => !result.ok && !result.chroma)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
