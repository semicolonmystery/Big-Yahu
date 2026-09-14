import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, TextBasedChannel } from 'discord.js';

const state = vi.hoisted(() => ({
  checkpoint: null as string | null,
  advance: vi.fn(),
  cache: vi.fn(),
  addFacts: vi.fn(async () => [] as string[]),
  extract: vi.fn(async (_options: { windowMessages: unknown[] }) => ({ facts: [], needsMoreContext: false })),
  hourly: vi.fn(),
  images: vi.fn<typeof import('../../src/server/bot/attachments').imagePartsFor>(),
  markUnseen: vi.fn((messages: unknown[], _unseen: Map<string, number>) => messages),
  settings: vi.fn(() => ({ visionEnabled: true, maxImages: 4, timezone: 'UTC' })),
  text: vi.fn(async (_messages: Message[], _budget: { bytes: number; files: number }) => new Map<string, string>()),
}));

vi.mock('../../src/server/ai/context', () => ({
  markUnseenImages: state.markUnseen,
  mentionRoster: () => new Map(),
  runEscalatableExtraction: state.extract,
  toWindowMessage: (message: Message) => ({
    id: message.id, authorId: message.author.id, authorUsername: message.author.username,
    displayName: message.author.username, content: message.content, createdAt: message.createdTimestamp, isSelf: false,
  }),
}));
vi.mock('../../src/server/db/repositories/checkpointRepo', () => ({
  getCheckpoint: () => ({ lastMessageId: state.checkpoint }),
  advanceCheckpoint: (channelId: string, id: string | null) => {
    state.advance(channelId, id);
    if (id !== null) state.checkpoint = id;
  },
}));
vi.mock('../../src/server/db/repositories/factsRepo', () => ({ addFacts: state.addFacts }));
vi.mock('../../src/server/db/repositories/cachedMessagesRepo', () => ({ cacheMessages: state.cache }));
vi.mock('../../src/server/plugins/engine', () => ({
  runOnHourlyCheck: state.hourly, collectExtractionAnnotations: async () => '',
}));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({
  getSettings: state.settings,
}));
vi.mock('../../src/server/bot/attachments', () => ({ imagePartsFor: state.images }));
vi.mock('../../src/server/bot/textAttachments', () => ({
  readTextAttachments: state.text, createTextAttachmentBudget: () => ({ bytes: 64 * 1024, files: 8 }),
}));

import { runExtractionForChannel } from '../../src/server/ai/factExtraction';

function message(id: number, content = 'A useful message', bot = false): Message {
  return {
    id: String(id), content, createdTimestamp: id, author: { id: 'author', username: 'Alice', bot },
    attachments: new Map(),
  } as unknown as Message;
}

function channel(messages: Message[], fetchOverride?: ReturnType<typeof vi.fn>) {
  const fetch = fetchOverride ?? vi.fn(async ({ after, limit }: { after?: string; limit: number }) => {
    const remaining = after ? messages.filter((message) => BigInt(message.id) > BigInt(after)) : messages.slice(-limit);
    return new Map(remaining.slice(0, limit).map((message) => [message.id, message]));
  });
  return { object: { id: 'channel', messages: { fetch } } as unknown as TextBasedChannel, fetch };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.checkpoint = null;
  state.text.mockResolvedValue(new Map());
  state.images.mockResolvedValue({ images: [], unseen: new Map() });
  state.markUnseen.mockImplementation((messages) => messages);
  state.settings.mockReturnValue({ visionEnabled: true, maxImages: 4, timezone: 'UTC' });
});

describe('periodic fact extraction', () => {
  it('includes image-only messages in extraction and vision', async () => {
    const picture = message(1, '');
    const { object } = channel([picture]);
    await runExtractionForChannel(object, 'guild');
    expect(state.images).toHaveBeenCalledWith([picture], 4);
    expect(state.extract).toHaveBeenCalledWith(expect.objectContaining({
      windowMessages: [expect.objectContaining({ id: '1', content: '' })],
    }));
    expect(state.checkpoint).toBe('1');
  });

  it('keeps image-only messages marked when vision is disabled without downloading images', async () => {
    const { imagePartsFor } = await vi.importActual<typeof import('../../src/server/bot/attachments')>('../../src/server/bot/attachments');
    state.images.mockImplementationOnce(imagePartsFor);
    state.settings.mockReturnValue({ visionEnabled: false, maxImages: 4, timezone: 'UTC' });
    const download = vi.fn();
    vi.stubGlobal('fetch', download);
    const picture = Object.assign(message(1, ''), {
      attachments: new Map([['image', { contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/picture.png' }]]),
      embeds: [],
    });
    const marked = [{ id: '1', authorId: 'author', authorUsername: 'Alice', displayName: 'Alice', content: '', createdAt: 1, isSelf: false, unseenImages: 1 }];
    state.markUnseen.mockReturnValueOnce(marked);
    await runExtractionForChannel(channel([picture]).object, 'guild');
    expect(state.images).toHaveBeenCalledExactlyOnceWith([picture], 0);
    expect(download).not.toHaveBeenCalled();
    expect(state.markUnseen).toHaveBeenCalledWith(expect.any(Array), new Map([['1', 1]]));
    expect(state.extract).toHaveBeenCalledWith(expect.objectContaining({ windowMessages: marked, images: [] }));
    expect(state.checkpoint).toBe('1');
  });

  it('appends bounded text attachment content to both prompt and cached source', async () => {
    state.text.mockResolvedValueOnce(new Map([['1', '[attachment message.txt]\nA long pasted message']]));
    const { object } = channel([message(1, '')]);
    await runExtractionForChannel(object, 'guild');
    const content = '[attachment message.txt]\nA long pasted message';
    expect(state.extract).toHaveBeenCalledWith(expect.objectContaining({
      windowMessages: [expect.objectContaining({ content })],
    }));
    expect(state.cache).toHaveBeenCalledWith([expect.objectContaining({ content })]);
    expect(state.extract).toHaveBeenCalledWith(expect.objectContaining({
      attachmentBudget: state.text.mock.calls[0][1],
    }));
  });

  it('limits each prompt to 100 messages and each run to five checkpointed pages', async () => {
    state.checkpoint = '0';
    const { object, fetch } = channel(Array.from({ length: 700 }, (_, index) => message(index + 1)));
    await runExtractionForChannel(object, 'guild');
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(state.extract.mock.calls.every(([options]) => options.windowMessages.length === 100)).toBe(true);
    expect(state.advance.mock.calls.map(([, id]) => id)).toEqual(['100', '200', '300', '400', '500']);
    await runExtractionForChannel(object, 'guild');
    expect(state.checkpoint).toBe('700');
  });

  it('preserves the last successful page checkpoint when the following page fails', async () => {
    state.checkpoint = '0';
    const { object } = channel(Array.from({ length: 150 }, (_, index) => message(index + 1)));
    state.addFacts.mockResolvedValueOnce(['fact']).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(runExtractionForChannel(object, 'guild')).rejects.toThrow('storage unavailable');
    expect(state.checkpoint).toBe('100');
    await runExtractionForChannel(object, 'guild');
    expect(state.checkpoint).toBe('150');
  });

  it('advances through bot-only pages without asking a model', async () => {
    state.checkpoint = '0';
    const { object } = channel([message(1, 'Bot noise', true)]);
    await runExtractionForChannel(object, 'guild');
    expect(state.extract).not.toHaveBeenCalled();
    expect(state.checkpoint).toBe('1');
  });

  it('keeps the first extraction to the latest 100 messages', async () => {
    const { object, fetch } = channel(Array.from({ length: 250 }, (_, index) => message(index + 1)));
    await runExtractionForChannel(object, 'guild');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.extract).toHaveBeenCalledWith(expect.objectContaining({
      windowMessages: expect.arrayContaining([expect.objectContaining({ id: '151' }), expect.objectContaining({ id: '250' })]),
    }));
  });

  it('does not process the same channel concurrently', async () => {
    const { object, fetch } = channel([message(1)]);
    await Promise.all([runExtractionForChannel(object, 'guild'), runExtractionForChannel(object, 'guild')]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
