import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import type { Client, Message } from 'discord.js';

const mocks = vi.hoisted(() => ({
  isServedGuild: vi.fn(), ensureChannel: vi.fn(), canExtractFrom: vi.fn(), canReplyIn: vi.fn(),
  runOnMessage: vi.fn(), runOnBotTagged: vi.fn(), handleMention: vi.fn(),
}));
vi.mock('../../src/server/env', () => ({ isServedGuild: mocks.isServedGuild }));
vi.mock('../../src/server/db/repositories/checkpointRepo', () => ({ ensureChannel: mocks.ensureChannel }));
vi.mock('../../src/server/db/repositories/channelSettingsRepo', () => ({ canExtractFrom: mocks.canExtractFrom, canReplyIn: mocks.canReplyIn }));
vi.mock('../../src/server/plugins/engine', () => ({ runOnMessage: mocks.runOnMessage, runOnBotTagged: mocks.runOnBotTagged }));
vi.mock('../../src/server/bot/replyPipeline', () => ({ handleMention: mocks.handleMention }));

const botId = 'bot-id';
let client: EventEmitter & { user: { id: string } | null };
let handlers: typeof import('../../src/server/bot/events/messageCreate');
const pending: Array<() => void> = [];

const message = (overrides: Record<string, unknown> = {}): Message => ({
  id: 'message-id', author: { id: 'alice', bot: false }, guildId: 'served-guild', channelId: 'readable-channel',
  reference: null, mentions: { users: new Map([[botId, { id: botId }]]), repliedUser: null }, ...overrides,
}) as unknown as Message;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  mocks.isServedGuild.mockImplementation((guildId: string | null) => guildId === 'served-guild');
  mocks.canExtractFrom.mockReturnValue(true);
  mocks.canReplyIn.mockReturnValue(true);
  mocks.runOnMessage.mockResolvedValue(undefined);
  mocks.runOnBotTagged.mockResolvedValue(undefined);
  mocks.handleMention.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  handlers = await import('../../src/server/bot/events/messageCreate');
  client = Object.assign(new EventEmitter(), { user: { id: botId } as { id: string } | null });
  handlers.registerMessageCreate(client as unknown as Client);
});

afterEach(async () => {
  for (const resolve of pending.splice(0)) resolve();
  await handlers.drainMessageHandlers();
  client.removeAllListeners();
});

describe('Discord message admission', () => {
  it.each([
    { guildId: 'foreign-guild' }, { guildId: null }, { author: { id: 'another-bot', bot: true } },
  ])('ignores foreign guilds, DMs and bots before database, plugin or AI work: %j', async (overrides) => {
    client.emit(Events.MessageCreate, message(overrides));
    await handlers.drainMessageHandlers();
    expect(mocks.canExtractFrom).not.toHaveBeenCalled();
    expect(mocks.ensureChannel).not.toHaveBeenCalled();
    expect(mocks.canReplyIn).not.toHaveBeenCalled();
    expect(mocks.runOnMessage).not.toHaveBeenCalled();
    expect(mocks.runOnBotTagged).not.toHaveBeenCalled();
    expect(mocks.handleMention).not.toHaveBeenCalled();
  });

  it.each([
    { reference: null, mentions: { users: new Map([[botId, { id: botId }]]), repliedUser: null } },
    { reference: { messageId: 'bot-message' }, mentions: { users: new Map(), repliedUser: { id: botId } } },
  ])('replies to a direct mention or a reply to the bot: %j', async (overrides) => {
    const incoming = message(overrides);
    client.emit(Events.MessageCreate, incoming);
    await handlers.drainMessageHandlers();
    expect(mocks.ensureChannel).toHaveBeenCalledWith('readable-channel', 'served-guild');
    expect(mocks.runOnMessage).toHaveBeenCalledWith({ message: incoming });
    expect(mocks.runOnBotTagged).toHaveBeenCalledWith({ message: incoming });
    expect(mocks.handleMention).toHaveBeenCalledWith(incoming);
    expect(mocks.runOnMessage.mock.invocationCallOrder[0]).toBeLessThan(mocks.runOnBotTagged.mock.invocationCallOrder[0]);
    expect(mocks.runOnBotTagged.mock.invocationCallOrder[0]).toBeLessThan(mocks.handleMention.mock.invocationCallOrder[0]);
  });

  it('runs ordinary message hooks but does not answer @everyone or a reply to someone else', async () => {
    client.emit(Events.MessageCreate, message({
      content: '@everyone', reference: { messageId: 'someone-else' },
      mentions: { users: new Map(), repliedUser: { id: 'other-person' }, everyone: true },
    }));
    await handlers.drainMessageHandlers();
    expect(mocks.runOnMessage).toHaveBeenCalledTimes(1);
    expect(mocks.runOnBotTagged).not.toHaveBeenCalled();
    expect(mocks.handleMention).not.toHaveBeenCalled();
  });

  it('keeps reply-disabled channels silent, including their plugin hooks', async () => {
    mocks.canReplyIn.mockReturnValue(false);
    client.emit(Events.MessageCreate, message());
    await handlers.drainMessageHandlers();
    expect(mocks.ensureChannel).toHaveBeenCalledTimes(1);
    expect(mocks.runOnMessage).not.toHaveBeenCalled();
    expect(mocks.runOnBotTagged).not.toHaveBeenCalled();
    expect(mocks.handleMention).not.toHaveBeenCalled();
  });

  it('permits a reply without registering an unreadable channel for extraction', async () => {
    mocks.canExtractFrom.mockReturnValue(false);
    client.emit(Events.MessageCreate, message());
    await handlers.drainMessageHandlers();
    expect(mocks.ensureChannel).not.toHaveBeenCalled();
    expect(mocks.handleMention).toHaveBeenCalledTimes(1);
  });

  it('does not invoke reply work before the client has its own user', async () => {
    client.user = null;
    client.emit(Events.MessageCreate, message());
    await handlers.drainMessageHandlers();
    expect(mocks.runOnMessage).toHaveBeenCalledTimes(1);
    expect(mocks.runOnBotTagged).not.toHaveBeenCalled();
    expect(mocks.handleMention).not.toHaveBeenCalled();
  });
});

describe('message handler failure and shutdown', () => {
  it.each(['runOnMessage', 'runOnBotTagged', 'handleMention'] as const)('catches %s rejection without an unhandled rejection or stopping later messages', async (stage) => {
    const failure = new Error(`${stage} failed`);
    mocks[stage].mockRejectedValueOnce(failure);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      client.emit(Events.MessageCreate, message({ id: 'failed-message' }));
      await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
      const next = message({ id: 'next-message' });
      client.emit(Events.MessageCreate, next);
      await handlers.drainMessageHandlers();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(mocks.handleMention).toHaveBeenLastCalledWith(next);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('failed'), failure);
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
  });

  it.each(['runOnMessage', 'runOnBotTagged', 'handleMention'] as const)('drains outstanding %s work and stops accepting new messages', async (stage) => {
    let resolveWork!: () => void;
    const held = new Promise<void>((resolve) => { resolveWork = resolve; });
    pending.push(resolveWork);
    mocks[stage].mockReturnValueOnce(held);
    client.emit(Events.MessageCreate, message({ id: 'in-flight' }));
    await vi.waitFor(() => expect(mocks[stage]).toHaveBeenCalledTimes(1));
    let drained = false;
    const drain = handlers.drainMessageHandlers().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    client.emit(Events.MessageCreate, message({ id: 'during-drain' }));
    expect(mocks.runOnMessage).toHaveBeenCalledTimes(1);
    resolveWork();
    await drain;
    expect(drained).toBe(true);
    expect(mocks.handleMention).toHaveBeenCalledTimes(1);
    client.emit(Events.MessageCreate, message({ id: 'after-drain' }));
    expect(mocks.runOnMessage).toHaveBeenCalledTimes(1);
  });
});
