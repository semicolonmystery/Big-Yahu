import { describe, expect, it, vi } from 'vitest';

// `env` is parsed once at import, so each case imports a fresh copy after
// stubbing the variable it reads.
async function loadClient(key: string | undefined) {
  vi.resetModules();
  // Without the bot running, a missing key is allowed through to the client,
  // which is the case being tested. With it, startup refuses first.
  vi.stubEnv('DISCORD_TOKEN', '');
  vi.stubEnv('OPENROUTER_API_KEY', key ?? '');
  return import('../../src/server/ai/openrouter');
}

describe('the OpenRouter client', () => {
  it('refuses to exist without a key rather than sending unauthenticated requests', async () => {
    const { openrouter } = await loadClient(undefined);
    expect(() => openrouter()).toThrow('OPENROUTER_API_KEY is not set');
  });

  it('points at OpenRouter and leaves retrying to the model pool', async () => {
    const { openrouter, OPENROUTER_BASE_URL } = await loadClient('sk-or-test');
    const client = openrouter();
    expect(client.baseURL).toBe(OPENROUTER_BASE_URL);
    expect(client.maxRetries).toBe(0);
    expect(client.timeout).toBe(45_000);
  });

  it('is built once and reused', async () => {
    const { openrouter } = await loadClient('sk-or-test');
    expect(openrouter()).toBe(openrouter());
  });
});
