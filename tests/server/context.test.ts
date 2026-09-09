import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityType, MessageType } from 'discord.js';
import type { Message, TextBasedChannel } from 'discord.js';
import type { Fact } from '../../src/shared/types';
import type { TextAttachmentBudget } from '../../src/server/bot/textAttachments';

const state = vi.hoisted(() => ({
  settings: { maxEscalationDepth: 1, escalationLookbackHours: 24, factSearchTopK: 5 },
  generate: vi.fn(async (_contents: unknown, _options: unknown): Promise<{ text: string | undefined }> => ({ text: '{"facts":[],"needsMoreContext":false}' })),
  search: vi.fn(async (_query: string, _count: number, _where: unknown): Promise<Fact[]> => []),
  attachments: vi.fn(async (_messages: Message[], _budget?: TextAttachmentBudget) => new Map<string, string>()),
  allowed: new Set(['open']),
}));

vi.mock('../../src/server/ai/generate', () => ({ generate: state.generate }));
vi.mock('../../src/server/db/repositories/factsRepo', () => ({ searchFacts: state.search }));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({ getSettings: () => state.settings }));
vi.mock('../../src/server/db/repositories/channelSettingsRepo', () => ({ canExtractFrom: (id: string) => state.allowed.has(id) }));
vi.mock('../../src/server/bot/textAttachments', () => ({ readTextAttachments: state.attachments }));

import {
  describeActivities, describeSelf, effectiveMaxDepth, fetchOlderMessages, fetchRecentMessages, formatFacts,
  formatTranscript, listGuildPeople, markUnseenImages, mentionRoster, runEscalatableExtraction,
  toWindowMessage, windowMessagesWithAttachments,
} from '../../src/server/ai/context';
import { extractTopic } from '../../src/server/ai/topicExtraction';
import { rewriteForFactSearch } from '../../src/server/ai/queryRewrite';
import { extractionSchema } from '../../src/server/ai/schemas';

function message(id: number, overrides: Record<string, unknown> = {}): Message {
  return {
    id: String(id), content: 'A message', createdTimestamp: id * 1000, type: MessageType.Default,
    author: { id: '111', username: 'alice', displayName: 'Alice', bot: false }, member: { displayName: 'Alice Server' },
    client: { user: { id: '999', username: 'bot', displayName: 'Bot' } }, reference: null,
    mentions: { users: new Map(), members: new Map(), channels: new Map(), repliedUser: null },
    ...overrides,
  } as unknown as Message;
}

function channel(messages: Message[] = []) {
  const fetch = vi.fn(async (_options: unknown) => new Map(messages.map((entry) => [entry.id, entry])));
  return { object: { messages: { fetch } } as unknown as TextBasedChannel, fetch };
}

function fact(id: string, channelId: string): Fact {
  return { id, text: `${id} fact text`, metadata: {
    guildId: 'guild', channelId, messageIds: ['10'], authorIds: ['111'], referencedFactIds: [],
    source: 'auto', timePeriodStart: 0, timePeriodEnd: 1, createdAt: 1,
  } };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.generate.mockResolvedValue({ text: '{"facts":[],"needsMoreContext":false}' });
  state.search.mockResolvedValue([]);
  state.attachments.mockResolvedValue(new Map());
  state.settings.maxEscalationDepth = 1;
  state.allowed.clear();
  state.allowed.add('open');
});

describe('conversation formatting', () => {
  it('keeps Discord IDs while annotating users and channels with current names', () => {
    const source = message(10, {
      content: '<@222> and <@!222> in <#333>',
      mentions: {
        users: new Map([['222', { username: 'bob', displayName: 'Bob' }]]),
        members: new Map([['222', { displayName: 'Bobby' }]]), channels: new Map([['333', { name: 'general' }]]),
      },
    });
    expect(toWindowMessage(source)).toMatchObject({
      displayName: 'Alice Server', content: '<@222>(Bobby) and <@222>(Bobby) in <#333>(#general)',
    });
  });

  it('marks genuine replies but does not mistake forwarded references for replies', () => {
    const reply = message(10, {
      type: MessageType.Reply, reference: { messageId: '5' },
      mentions: { users: new Map(), members: new Map(), channels: new Map(), repliedUser: { id: '222' } },
    });
    expect(toWindowMessage(reply)).toMatchObject({ replyToId: '5', replyToAuthorId: '222' });
    expect(toWindowMessage(message(11, { reference: { messageId: '5' } })).replyToId).toBeUndefined();
    expect(formatTranscript([toWindowMessage(reply)])).toContain('[replying to id=5 by <@222>]');
  });

  it('labels the bot as you and marks unseen images without mutating the input', () => {
    const own = message(10, { author: { id: '999', username: 'bot', bot: true } });
    const window = [toWindowMessage(own), toWindowMessage(message(11))];
    const marked = markUnseenImages(window, new Map([['10', 1], ['11', 2]]));
    expect(formatTranscript(marked)).toContain('you: A message [image not shown]');
    expect(formatTranscript(marked)).toContain('Alice Server aka alice <@111>: A message [2 images not shown]');
    expect(window[0].unseenImages).toBeUndefined();
  });

  it('builds a roster from nicknames and handles while excluding the bot itself', () => {
    const own = message(10, { author: { id: '999', username: 'bot', bot: true }, member: { displayName: 'Bot' } });
    expect(mentionRoster([toWindowMessage(own), toWindowMessage(message(11))]))
      .toEqual(new Map([['Alice Server', '111'], ['alice', '111']]));
  });

  it('formats remembered fact and channel IDs for linking and tool use', () => {
    expect(formatFacts([fact('fact-1', 'open')])).toBe('[factId=fact-1] [channelId=open] fact-1 fact text');
  });

  it('describes its server nickname separately from the global username', () => {
    const source = message(10, { guild: { members: { me: { displayName: 'Server Bot' } } } });
    expect(describeSelf(source)).toContain('You are <@999>');
    expect(describeSelf(source)).toContain('"Server Bot"');
    expect(describeSelf(source)).toContain('"bot"');
  });

  it('reads activity from presence even when the person has no cached member', () => {
    const source = message(10, { guild: {
      presences: { cache: new Map([['222', { status: 'online', activities: [
        { type: ActivityType.Playing, name: 'Chess', details: 'Ranked', state: null },
        { type: ActivityType.Custom, name: 'Custom Status', details: null, state: 'Studying' },
      ] }]]) }, members: { cache: new Map() },
    } });
    const text = describeActivities(source, [{ id: '222', displayName: 'Bob' }, { id: '333', displayName: 'Charlie' }]);
    expect(text).toContain('Bob <@222> — online, playing Chess (Ranked); status "Studying"');
    expect(text).toContain('Charlie <@333> — offline, or hiding it');
  });

  it('keeps a people listing explicitly partial and supports name filtering', () => {
    const source = message(10, { guild: {
      presences: { cache: new Map() }, members: { cache: new Map([
        ['222', { displayName: 'Bobby', user: { username: 'bob' } }],
        ['333', { displayName: 'Charlie', user: { username: 'charlie' } }],
      ]) },
    } });
    const listing = listGuildPeople(source, 'BOB');
    expect(listing).toContain('Bobby aka bob <@222>');
    expect(listing).not.toContain('Charlie');
    expect(listing).toContain('not the full member list');
    expect(listGuildPeople(source, 'nobody')).toContain('Nobody visible matches');
  });
});

describe('history and attachment context', () => {
  it('appends expanded attachment text using the supplied shared budget', async () => {
    state.attachments.mockResolvedValueOnce(new Map([['10', '[message.txt]\nPasted text']]));
    const budget = { bytes: 1000, files: 2 };
    const source = message(10, { content: '' });
    const window = await windowMessagesWithAttachments([source], budget);
    expect(window[0].content).toBe('[message.txt]\nPasted text');
    expect(state.attachments).toHaveBeenCalledWith([source], budget);
  });

  it('orders recent human messages chronologically, keeps image-only messages and caps fetch size', async () => {
    const { object, fetch } = channel([
      message(30), message(20, { content: '' }), message(10, { author: { id: '999', username: 'bot', bot: true } }),
    ]);
    const budget = { bytes: 1000, files: 2 };
    const result = await fetchRecentMessages(object, 999, budget);
    expect(fetch).toHaveBeenCalledWith({ limit: 100 });
    expect(result.map((entry) => entry.id)).toEqual(['20', '30']);
    expect(state.attachments.mock.calls[0][1]).toBe(budget);
  });

  it('filters old history by timestamp and excludes bots before attachment loading', async () => {
    const { object, fetch } = channel([
      message(30), message(20), message(10), message(25, { author: { id: '999', username: 'bot', bot: true } }),
    ]);
    const budget = { bytes: 1000, files: 2 };
    const result = await fetchOlderMessages(object, '50', 20_000, budget);
    expect(fetch).toHaveBeenCalledWith({ before: '50', limit: 100 });
    expect(result.map((entry) => entry.id)).toEqual(['20', '30']);
    expect(state.attachments.mock.calls[0][0].map((entry) => entry.id)).toEqual(['20', '30']);
    expect(state.attachments.mock.calls[0][1]).toBe(budget);
  });

  it('skips disabled or unreadable history without any fetch', async () => {
    const { object, fetch } = channel([message(10)]);
    expect(await fetchRecentMessages(object, 0)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await fetchOlderMessages({} as TextBasedChannel, '50', 0)).toEqual([]);
  });
});

describe('bounded context escalation', () => {
  function options() {
    const { object, fetch } = channel([message(5)]);
    const anchor = message(10, { channel: object });
    return { fetch, value: {
      schema: extractionSchema, systemInstruction: 'Extract facts', task: 'Read this channel',
      windowMessages: [toWindowMessage(anchor)], anchorMessage: anchor, guildId: 'guild',
      attachmentBudget: { bytes: 1000, files: 2 },
    } };
  }

  it('finishes after the first response when no more context is needed', async () => {
    const { value, fetch } = options();
    expect(await runEscalatableExtraction(value)).toMatchObject({ facts: [], needsMoreContext: false });
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enforces the hard depth cap and tells the final call to answer with existing context', async () => {
    state.settings.maxEscalationDepth = 999;
    state.generate.mockResolvedValue({ text: '{"facts":[],"needsMoreContext":true}' });
    const { value, fetch } = options();
    expect(effectiveMaxDepth()).toBe(3);
    await runEscalatableExtraction(value);
    expect(state.generate).toHaveBeenCalledTimes(4);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(state.generate.mock.calls.at(-1)?.[0]).toContain('No further context is available');
  });

  it('does not fetch extra context when escalation is disabled', async () => {
    state.settings.maxEscalationDepth = 0;
    state.generate.mockResolvedValue({ text: '{"facts":[],"needsMoreContext":true}' });
    const { value, fetch } = options();
    await runEscalatableExtraction(value);
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('filters opted-out channel memories and carries the attachment budget into older history', async () => {
    state.generate.mockResolvedValueOnce({ text: '{"facts":[],"needsMoreContext":true,"contextHint":"meeting"}' });
    state.search.mockResolvedValueOnce([fact('public', 'open'), fact('secret', 'closed')]);
    const { value } = options();
    await runEscalatableExtraction(value);
    expect(state.search).toHaveBeenCalledWith('meeting', 5, { guildId: 'guild' });
    expect(state.generate.mock.calls[1][0]).toContain('public fact text');
    expect(state.generate.mock.calls[1][0]).not.toContain('secret fact text');
    expect(state.attachments.mock.calls[0][1]).toBe(value.attachmentBudget);
  });

  it('keeps supplied image parts attached to structured extraction calls', async () => {
    const { value } = options();
    const part = { inlineData: { mimeType: 'image/png', data: 'data' } };
    await runEscalatableExtraction({ ...value, imageParts: [part] });
    expect(state.generate.mock.calls[0][0]).toEqual([{ role: 'user', parts: [expect.objectContaining({ text: expect.any(String) }), part] }]);
  });

  it.each([undefined, '', 'not-json'])('fails visibly on empty or malformed structured output %#', async (text) => {
    state.generate.mockResolvedValueOnce({ text });
    await expect(runEscalatableExtraction(options().value)).rejects.toThrow();
  });
});

describe('query rewriting and topic extraction', () => {
  it('uses a valid rewritten query and preserves the original mentions in the request', async () => {
    state.generate.mockResolvedValueOnce({ text: '{"rewritten":"  <@111> owns a dog.  "}' });
    expect(await rewriteForFactSearch('Does <@111> own a dog?')).toBe('<@111> owns a dog.');
    expect(state.generate).toHaveBeenCalledWith('Query: Does <@111> own a dog?', expect.objectContaining({ responseMimeType: 'application/json' }));
  });

  it.each(['{}', '{"rewritten":123}', '{"rewritten":" "}', 'not-json'])('falls back to the original query on unusable rewriting %#', async (text) => {
    state.generate.mockResolvedValueOnce({ text });
    expect(await rewriteForFactSearch('Original question')).toBe('Original question');
  });

  it('keeps search available if the rewrite service fails', async () => {
    state.generate.mockRejectedValueOnce(new Error('AI unavailable'));
    expect(await rewriteForFactSearch('Original question')).toBe('Original question');
  });

  it('uses chronological context with the tagging message last and includes its text attachment in the topic', async () => {
    const { object, fetch } = channel([message(20), message(10)]);
    const tagged = message(30, { content: '', channel: object });
    const budget = { bytes: 1000, files: 2 };
    state.attachments.mockResolvedValueOnce(new Map([['30', '[message.txt]\nWhat did Bob decide?']]));
    state.generate.mockResolvedValueOnce({ text: '{"coreTopic":"Decision","whatTaggingMessageIsAbout":"Bob decision","facts":[],"needsMoreContext":false}' });
    const result = await extractTopic(tagged, 'guild', 20, budget);
    expect(fetch).toHaveBeenCalledWith({ before: '30', limit: 20 });
    expect(result.discordMessages.map((entry) => entry.id)).toEqual(['10', '20', '30']);
    expect(result.windowMessages.at(-1)?.content).toContain('What did Bob decide?');
    expect(result.topic.coreTopic).toBe('Decision');
    expect(state.generate.mock.calls[0][0]).toContain('What did Bob decide?');
    expect(state.attachments.mock.calls[0][1]).toBe(budget);
  });
});
