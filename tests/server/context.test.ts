import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityType, MessageType } from 'discord.js';
import type { Message, TextBasedChannel } from 'discord.js';
import type { Fact } from '../../src/shared/types';
import type { TextAttachmentBudget } from '../../src/server/bot/textAttachments';

const state = vi.hoisted(() => ({
  settings: {
    maxEscalationDepth: 1, escalationLookbackHours: 24, factSearchTopK: 5,
    rateLimitMessage: '', overloadMessage: '', busyMessage: '', errorMessage: '', noCreditsMessage: '',
  },
  structured: vi.fn(async (
    _task: string,
    _request: { system: string; user: string; images?: unknown[]; schema: unknown; maxOutputTokens?: number },
  ): Promise<unknown> => ({ facts: [], needsMoreContext: false, contextHint: '' })),
  search: vi.fn(async (_query: string, _count: number, _where: unknown): Promise<Fact[]> => []),
  attachments: vi.fn(async (_messages: Message[], _budget?: TextAttachmentBudget) => new Map<string, string>()),
  allowed: new Set(['open']),
}));

// Only the call is replaced; UnreadableAnswerError stays the real class, so the
// narrowing logic under test recognises what the runner would throw.
vi.mock('../../src/server/ai/structured', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/server/ai/structured')>(),
  structured: state.structured,
}));
vi.mock('../../src/server/db/repositories/factsRepo', () => ({ searchFacts: state.search }));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({ getSettings: () => state.settings }));
vi.mock('../../src/server/db/repositories/channelSettingsRepo', () => ({ canExtractFrom: (id: string) => state.allowed.has(id) }));
vi.mock('../../src/server/bot/textAttachments', () => ({ readTextAttachments: state.attachments }));

import {
  effectiveMaxDepth, fetchOlderMessages, fetchRecentMessages, listGuildPeople, markUnseenImages, mentionRoster,
  presenceFor, runEscalatableExtraction, selfMaterial, toWindowMessage, windowMessagesWithAttachments,
} from '../../src/server/ai/context';
import { factsMaterial, messageMaterial, messagesMaterial } from '../../src/server/ai/material';
import { extractTopic } from '../../src/server/ai/topicExtraction';
import { UnreadableAnswerError } from '../../src/server/ai/structured';
import { extractionSchemaFor } from '../../src/server/ai/schemas';

// The type list is the operator's, so the schema is built per call; these tests
// only care that the same shape reaches the model each time.
const extractionSchema = extractionSchemaFor([]);
import { HOST_FAILURE_NOTICE } from '../../src/shared/constants';
import { REPLY_DEFAULT, TOPIC_EXTRACTION_DEFAULT } from '../../src/server/ai/prompts/systemInstructions';

/** What the extraction runner was asked on its nth call. */
const request = (call: number) => state.structured.mock.calls[call][1];

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
  state.structured.mockResolvedValue({ facts: [], needsMoreContext: false, contextHint: '' });
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
    expect(messageMaterial(toWindowMessage(reply)).replyTo).toEqual({ id: '5', authorId: '222' });
  });

  it('marks its own lines and unseen images without mutating the input', () => {
    const own = message(10, { author: { id: '999', username: 'bot', bot: true } });
    const window = [toWindowMessage(own), toWindowMessage(message(11))];
    const marked = messagesMaterial(markUnseenImages(window, new Map([['10', 1], ['11', 2]])));
    expect(marked[0]).toMatchObject({ authorId: 'you', unseenImages: 1 });
    expect(marked[1]).toMatchObject({ authorId: '111', unseenImages: 2 });
    expect(window[0].unseenImages).toBeUndefined();
  });

  it('builds a roster from nicknames and handles while excluding the bot itself', () => {
    const own = message(10, { author: { id: '999', username: 'bot', bot: true }, member: { displayName: 'Bot' } });
    expect(mentionRoster([toWindowMessage(own), toWindowMessage(message(11))]))
      .toEqual(new Map([['Alice Server', '111'], ['alice', '111']]));
  });

  it('keeps a remembered fact with the channel it came from, for linking and tool use', () => {
    expect(factsMaterial([fact('fact-1', 'open')])[0])
      .toEqual({ id: 'fact-1', channelId: 'open', text: 'fact-1 fact text' });
  });

  it('gives its server nickname first, then the names it is otherwise known by', () => {
    const source = message(10, { guild: { members: { me: { displayName: 'Server Bot' } } } });
    expect(selfMaterial(source)).toEqual({ id: '999', names: ['Server Bot', 'Bot', 'bot'] });
  });

  it('reads activity from presence even when the person has no cached member', () => {
    const source = message(10, { guild: {
      presences: { cache: new Map([['222', { status: 'online', activities: [
        { type: ActivityType.Playing, name: 'Chess', details: 'Ranked', state: null },
        { type: ActivityType.Custom, name: 'Custom Status', details: null, state: 'Studying' },
      ] }]]) }, members: { cache: new Map() },
    } });
    const presence = presenceFor(source, ['222', '333']);
    expect(presence.get('222')).toEqual({ status: 'online', doing: 'playing Chess (Ranked); status "Studying"' });
    // Said outright rather than left out: absence reads as missing data and invites a guess.
    expect(presence.get('333')).toEqual({ status: 'offline, or hiding it' });
  });

  it('keeps a people listing explicitly partial and supports name filtering', () => {
    const source = message(10, { guild: {
      presences: { cache: new Map() }, members: { cache: new Map([
        ['222', { displayName: 'Bobby', user: { username: 'bob' } }],
        ['333', { displayName: 'Charlie', user: { username: 'charlie' } }],
      ]) },
    } });
    const listing = listGuildPeople(source, 'BOB');
    expect(listing.people).toEqual([{ id: '222', name: 'Bobby', username: 'bob', status: 'offline, or hiding it' }]);
    expect(listing.visibleOnly).toBe(true);
    expect(listing.matching).toBe('BOB');
    // Never the full member list, and it says so as a field rather than in prose,
    // so nobody missing reads as proof they left the server.
    expect(listGuildPeople(source, 'nobody')).toEqual({ people: [], visibleOnly: true, matching: 'nobody' });
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
  const answer = (overrides: Record<string, unknown> = {}) =>
    ({ facts: [], needsMoreContext: false, contextHint: '', ...overrides });

  function options() {
    const { object, fetch } = channel([message(5)]);
    const anchor = message(10, { channel: object });
    return { fetch, value: {
      aiTask: 'factExtraction', schema: extractionSchema, systemInstruction: 'Extract facts', task: 'Read this channel',
      windowMessages: [toWindowMessage(anchor)], anchorMessage: anchor, guildId: 'guild',
      attachmentBudget: { bytes: 1000, files: 2 },
    } };
  }

  it('finishes after the first answer when no more context is needed', async () => {
    const { value, fetch } = options();
    expect(await runEscalatableExtraction(value)).toMatchObject({ facts: [], needsMoreContext: false });
    expect(state.structured).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks the task's own model list, with the operator's prompt and room for a whole page of facts", async () => {
    await runEscalatableExtraction(options().value);
    expect(state.structured).toHaveBeenCalledWith('factExtraction', expect.objectContaining({
      system: 'Extract facts', schema: extractionSchema, maxOutputTokens: 32_768,
    }));
  });

  it('hands over the window as JSON, with the time and the caller\'s own fields', async () => {
    const { value } = options();
    await runEscalatableExtraction({ ...value, material: { channelId: 'channel', images: [{ index: 1, messageId: '10' }] } });
    const material = JSON.parse(request(0).user);
    expect(material).toMatchObject({
      task: 'Read this channel',
      channelId: 'channel',
      images: [{ index: 1, messageId: '10' }],
      messages: [{ id: '10', authorId: '111', content: 'A message' }],
    });
    expect(material.now).toEqual(expect.any(String));
    expect(material.messages[0].at).toBe(new Date(10_000).toISOString());
    expect(material.noFurtherContext).toBeUndefined();
  });

  it('enforces the hard depth cap and tells the final call to answer with existing context', async () => {
    state.settings.maxEscalationDepth = 999;
    state.structured.mockResolvedValue(answer({ needsMoreContext: true }));
    const { value, fetch } = options();
    expect(effectiveMaxDepth()).toBe(3);
    await runEscalatableExtraction(value);
    expect(state.structured).toHaveBeenCalledTimes(4);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(request(3).user).noFurtherContext).toBe(true);
  });

  it('does not fetch extra context when escalation is disabled', async () => {
    state.settings.maxEscalationDepth = 0;
    state.structured.mockResolvedValue(answer({ needsMoreContext: true }));
    const { value, fetch } = options();
    await runEscalatableExtraction(value);
    expect(state.structured).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('filters opted-out channel memories and carries the attachment budget into older history', async () => {
    state.structured.mockResolvedValueOnce(answer({ needsMoreContext: true, contextHint: 'meeting' }));
    state.search.mockResolvedValueOnce([fact('public', 'open'), fact('secret', 'closed')]);
    const { value } = options();
    await runEscalatableExtraction(value);
    expect(state.search).toHaveBeenCalledWith('meeting', 5, { guildId: 'guild' });
    expect(request(1).user).toContain('public fact text');
    expect(request(1).user).not.toContain('secret fact text');
    expect(state.attachments.mock.calls[0][1]).toBe(value.attachmentBudget);
  });

  it("searches with the caller's own hint when the answer asked for context without saying what", async () => {
    state.structured.mockResolvedValueOnce(answer({ needsMoreContext: true, searchQuery: 'the trip' }));
    await runEscalatableExtraction<{ needsMoreContext: boolean; contextHint: string; searchQuery: string }>({
      ...options().value,
      hint: (result) => result.searchQuery,
    });
    expect(state.search).toHaveBeenCalledWith('the trip', 5, { guildId: 'guild' });
  });

  it('keeps supplied pictures attached to the extraction call', async () => {
    const images = [{ messageId: '10', mimeType: 'image/png', data: 'data' }];
    await runEscalatableExtraction({ ...options().value, images });
    expect(request(0).images).toEqual(images);
  });

  describe('answers that cannot be read', () => {
    /** A window wide enough that dropping its older half is observable. */
    function wideOptions() {
      const { object } = channel([message(1)]);
      const anchor = message(10, { channel: object });
      const window = [1, 2, 3, 4].map((id) => toWindowMessage(message(id, { content: `Line ${id}` })));
      return {
        aiTask: 'factExtraction', schema: extractionSchema, systemInstruction: 'Extract facts', task: 'Read this channel',
        windowMessages: window, anchorMessage: anchor, guildId: 'guild',
      };
    }

    it('retries a truncated answer on the newest half of the window', async () => {
      state.structured.mockRejectedValueOnce(new UnreadableAnswerError('a/model ran out of output budget after 900 characters', true));
      expect(await runEscalatableExtraction(wideOptions())).toMatchObject({ needsMoreContext: false });
      expect(state.structured).toHaveBeenCalledTimes(2);

      // The oldest half goes; the newest messages are the ones kept.
      const retry = request(1).user;
      expect(retry).not.toContain('Line 1');
      expect(retry).not.toContain('Line 2');
      expect(retry).toContain('Line 3');
      expect(retry).toContain('Line 4');
    });

    it('retries an answer that came back in the wrong shape the same way', async () => {
      state.structured.mockRejectedValueOnce(new UnreadableAnswerError('a/model twice answered in the wrong shape', false));
      expect(await runEscalatableExtraction(wideOptions())).toMatchObject({ needsMoreContext: false });
      expect(state.structured).toHaveBeenCalledTimes(2);
    });

    it('gives up rather than narrowing forever', async () => {
      state.structured.mockRejectedValue(new UnreadableAnswerError('a/model ran out of output budget after 10 characters', true));
      await expect(runEscalatableExtraction(wideOptions())).rejects.toThrow('ran out of output budget');
      // The first attempt plus its two retries, and no escalation past them.
      expect(state.structured).toHaveBeenCalledTimes(3);
    });

    it('lets any other failure through without narrowing', async () => {
      state.structured.mockRejectedValueOnce(new Error('every model failed'));
      await expect(runEscalatableExtraction(wideOptions())).rejects.toThrow('every model failed');
      expect(state.structured).toHaveBeenCalledTimes(1);
    });
  });
});

describe('topic extraction', () => {
  it('reads chronologically with the tagging message last, and asks the topic list what to search memory for', async () => {
    const { object, fetch } = channel([message(20), message(10)]);
    const tagged = message(30, { content: '', channel: object });
    const budget = { bytes: 1000, files: 2 };
    state.attachments.mockResolvedValueOnce(new Map([['30', '[message.txt]\nWhat did Bob decide?']]));
    state.structured.mockResolvedValueOnce({
      coreTopic: 'Decision', whatTaggingMessageIsAbout: 'Bob decision', staySilent: false,
      searches: [{ query: 'Bob decided something', type: 'decision', people: ['222'], channels: [], dateFrom: '', dateTo: '' }],
      needsMoreContext: false, contextHint: '',
    });
    const result = await extractTopic(tagged, 'guild', 20, budget);
    expect(fetch).toHaveBeenCalledWith({ before: '30', limit: 20 });
    expect(result.discordMessages.map((entry) => entry.id)).toEqual(['10', '20', '30']);
    expect(result.windowMessages.at(-1)?.content).toContain('What did Bob decide?');
    expect(result.topic).toMatchObject({
      coreTopic: 'Decision',
      searches: [expect.objectContaining({ query: 'Bob decided something', type: 'decision', people: ['222'] })],
    });
    expect(state.structured).toHaveBeenCalledWith('topicExtraction',
      expect.objectContaining({ schema: expect.objectContaining({ type: 'object' }) }));
    expect(request(0).user).toContain('What did Bob decide?');
    expect(state.attachments.mock.calls[0][1]).toBe(budget);
  });

  it('rewrites the bot\'s own outage messages into the notice, keeping them in place', async () => {
    state.settings.noCreditsMessage = 'im out of credit';
    state.settings.overloadMessage = 'everything is busy';
    const bot = { id: '999', username: 'bot', displayName: 'Bot', bot: true };
    const { object } = channel([
      message(10, { content: 'anyone there?' }),
      // Not something it decided to say: the host sends these when no model
      // could be reached at all, and read back they are its own conversation.
      message(11, { author: bot, content: 'im out of credit' }),
      message(12, { author: bot, content: '  everything is busy  ' }),
      // Something it actually said stays.
      message(13, { author: bot, content: 'yeah im here' }),
    ]);
    const tagged = message(30, { content: 'hello', channel: object });
    state.structured.mockResolvedValueOnce({
      coreTopic: 'greeting', whatTaggingMessageIsAbout: 'hello', searchQuery: 'hello',
      people: [], channels: [], dateFrom: '', dateTo: '', needsMoreContext: false, contextHint: '',
    });

    const result = await extractTopic(tagged, 'guild', 20, undefined);
    // Still there: people saw them and answer them, and a gap would leave those
    // replies answering nothing.
    expect(result.windowMessages.map((entry) => entry.id)).toEqual(['10', '11', '12', '13', '30']);
    expect(result.windowMessages.map((entry) => entry.content)).toEqual([
      'anyone there?', HOST_FAILURE_NOTICE, HOST_FAILURE_NOTICE, 'yeah im here', 'hello',
    ]);
    expect(request(0).user).not.toContain('im out of credit');
    expect(request(0).user).not.toContain('everything is busy');
  });

  it('says in the prompt what that notice is, so it is not read as something the bot meant', () => {
    expect(REPLY_DEFAULT).toContain(HOST_FAILURE_NOTICE);
    expect(TOPIC_EXTRACTION_DEFAULT).toContain(HOST_FAILURE_NOTICE);
  });

  it('tells the model its own lines are its own, by author rather than by a flag', async () => {
    const bot = { id: '999', username: 'bot', displayName: 'Bot', bot: true };
    const { object } = channel([message(10, { author: bot, content: 'said this before' })]);
    const tagged = message(30, { content: 'and now this', channel: object });
    state.structured.mockResolvedValueOnce({
      coreTopic: 'x', whatTaggingMessageIsAbout: 'x', searchQuery: 'x',
      people: [], channels: [], dateFrom: '', dateTo: '', needsMoreContext: false, contextHint: '',
    });

    await extractTopic(tagged, 'guild', 20, undefined);
    const sent = JSON.parse(request(0).user.slice(request(0).user.indexOf('{')));
    expect(sent.messages[0]).toMatchObject({ authorId: 'you', content: 'said this before' });
    expect(sent.messages[1]).toMatchObject({ authorId: '111' });
  });
});
