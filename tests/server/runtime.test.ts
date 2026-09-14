import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('DISCORD_TOKEN', '');
  vi.stubEnv('DISCORD_GUILD_ID', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
});
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

import { env, isServedGuild, parseEnvironment } from '../../src/server/env';

const guildId = '123456789012345678';

describe('runtime configuration', () => {
  beforeEach(() => { env.discordGuildId = undefined; });
  afterEach(() => { env.discordGuildId = undefined; });

  it('allows the admin panel without Discord or model credentials', () => {
    expect(parseEnvironment({})).toMatchObject({
      discordToken: undefined, discordGuildId: undefined, openrouterApiKey: undefined,
      port: 3000, chromaPort: 8000, trustedProxyHops: 0,
    });
    expect(isServedGuild(guildId)).toBe(false);
    expect(isServedGuild(null)).toBe(false);
  });

  it('rejects a token without a guild before the bot starts', () => {
    expect(() => parseEnvironment({ DISCORD_TOKEN: 'secret-token', OPENROUTER_API_KEY: 'secret-key' }))
      .toThrow('DISCORD_GUILD_ID is required');
  });

  it('rejects a token without an OpenRouter key', () => {
    expect(() => parseEnvironment({ DISCORD_TOKEN: 'secret-token', DISCORD_GUILD_ID: guildId }))
      .toThrow('OPENROUTER_API_KEY is required');
  });

  it.each(['all', '123', '00000000000000000', '-12345678901234567', '18446744073709551616', '123456789012345678901'])
    ('rejects the malformed guild ID %s without exposing tokens', (id) => {
      expect(() => parseEnvironment({ DISCORD_TOKEN: 'secret-token', DISCORD_GUILD_ID: id, OPENROUTER_API_KEY: 'secret-key' }))
        .toThrow(/^DISCORD_GUILD_ID must be a valid Discord server ID$/);
    });

  it('trims copied credentials and allows exactly the configured guild', () => {
    const parsed = parseEnvironment({ DISCORD_TOKEN: ' token ', DISCORD_GUILD_ID: ` ${guildId} `, OPENROUTER_API_KEY: ' key ' });
    expect(parsed).toMatchObject({ discordToken: 'token', discordGuildId: guildId, openrouterApiKey: 'key' });
    env.discordGuildId = parsed.discordGuildId;
    expect(isServedGuild(guildId)).toBe(true);
    expect(isServedGuild('223456789012345678')).toBe(false);
    expect(isServedGuild(null)).toBe(false);
  });

  it.each([
    { PORT: 'NaN' }, { PORT: '0' }, { PORT: '65536' }, { PORT: '3000.5' },
    { CHROMA_PORT: '-1' }, { TRUSTED_PROXY_HOPS: 'true' }, { TRUSTED_PROXY_HOPS: '-2' },
  ])('rejects invalid networking configuration %o', (values) => {
    expect(() => parseEnvironment(values)).toThrow('must be an integer');
  });
});

describe('graceful shutdown', () => {
  const mockedModules = [
    '../../src/server/app', '../../src/server/env', '../../src/server/db/client',
    '../../src/server/bot/client',
    '../../src/server/bot/events/ready', '../../src/server/bot/events/messageCreate',
    '../../src/server/plugins/engine', '../../src/server/scheduler/hourlyCheck',
    '../../src/server/ai/reembed',
  ];
  let previousExitCode: typeof process.exitCode;
  beforeEach(() => {
    previousExitCode = process.exitCode;
    vi.resetModules();
  });
  afterEach(() => {
    process.exitCode = previousExitCode;
    for (const module of mockedModules) vi.doUnmock(module);
  });

  it('stops intake and drains HTTP, extraction and replies before closing Discord and SQLite', async () => {
    const signals = new Map<string, () => void>();
    vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
      signals.set(event, listener);
      return process;
    }) as typeof process.once);
    let httpDone!: () => void;
    let extractionDone!: () => void;
    let repliesDone!: () => void;
    const close = vi.fn((done: () => void) => { httpDone = done; });
    const server = { close, on: vi.fn() };
    const stopScheduler = vi.fn(() => new Promise<void>((resolve) => { extractionDone = resolve; }));
    const drainMessageHandlers = vi.fn(() => new Promise<void>((resolve) => { repliesDone = resolve; }));
    const destroy = vi.fn(async () => {});
    const closeDatabase = vi.fn();
    vi.doMock('../../src/server/app', () => ({ createApp: () => ({ listen: () => server }) }));
    vi.doMock('../../src/server/env', () => ({ env: { port: 3000 } }));
    vi.doMock('../../src/server/db/client', () => ({ runMigrations: vi.fn(), closeDatabase }));
    vi.doMock('../../src/server/ai/reembed', () => ({ resumeReembedAtBoot: vi.fn(async () => {}) }));
    vi.doMock('../../src/server/bot/client', () => ({ discordClient: { destroy } }));
    vi.doMock('../../src/server/bot/events/ready', () => ({ registerReady: vi.fn() }));
    vi.doMock('../../src/server/bot/events/messageCreate', () => ({ registerMessageCreate: vi.fn(), drainMessageHandlers }));
    vi.doMock('../../src/server/plugins/engine', () => ({ attachDiscordClient: vi.fn(), loadPlugins: vi.fn(async () => {}) }));
    vi.doMock('../../src/server/scheduler/hourlyCheck', () => ({ startScheduler: vi.fn(), stopScheduler }));

    await import('../../src/server/index');
    signals.get('SIGTERM')!();
    signals.get('SIGINT')!();
    expect(close).toHaveBeenCalledTimes(1);
    expect(stopScheduler).toHaveBeenCalledTimes(1);
    expect(drainMessageHandlers).toHaveBeenCalledTimes(1);
    expect(closeDatabase).not.toHaveBeenCalled();
    httpDone();
    extractionDone();
    await Promise.resolve();
    expect(destroy).not.toHaveBeenCalled();
    repliesDone();
    await vi.waitFor(() => expect(closeDatabase).toHaveBeenCalledTimes(1));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(closeDatabase.mock.invocationCallOrder[0]);
    expect(process.exitCode).toBe(0);
  });
});
