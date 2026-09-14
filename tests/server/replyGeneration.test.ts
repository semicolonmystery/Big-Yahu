import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';
import type { DraftPrompt } from '@big-yahu/plugin-sdk';
import type { ReplyContext } from '../../src/server/ai/replyGeneration';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';

const m = vi.hoisted(() => ({
  chat: vi.fn(), addFacts: vi.fn(), deleteFact: vi.fn(), searchFacts: vi.fn(), recall: vi.fn(),
  canExtract: vi.fn(), runTool: vi.fn(), fetchOlder: vi.fn(), readChannel: vi.fn(),
  collectTools: vi.fn(),
}));
// Only the call is replaced; building the user message stays real, so the
// material and its pictures are assembled exactly as in production.
vi.mock('../../src/server/ai/chat', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/server/ai/chat')>(),
  chat: m.chat,
}));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({ getSettings: () => DEFAULT_SETTINGS }));
vi.mock('../../src/server/db/repositories/channelSettingsRepo', () => ({ canExtractFrom: m.canExtract }));
vi.mock('../../src/server/db/repositories/factsRepo', () => ({
  addFacts: m.addFacts, deleteFact: m.deleteFact, searchFacts: m.searchFacts,
  recallFacts: m.recall, recallForSearches: m.recall,
}));
vi.mock('../../src/server/db/repositories/cachedMessagesRepo', () => ({ cacheMessages: vi.fn(), getMessages: () => [] }));
vi.mock('../../src/server/plugins/engine', () => ({ collectTools: m.collectTools, runTool: m.runTool }));
vi.mock('../../src/server/bot/channelAccess', () => ({ resolveReadableChannel: m.readChannel }));
vi.mock('../../src/server/ai/context', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/server/ai/context')>(),
  effectiveMaxDepth: () => 1,
  fetchOlderMessages: m.fetchOlder,
  listGuildPeople: () => ({ people: [{ id: '12345678901234567', name: 'Alice', status: 'online' }], visibleOnly: true }),
}));
import { generateReply } from '../../src/server/ai/replyGeneration';

const messageId = '22222222222222222';
const userId = '12345678901234567';
const windowMessage = { id: messageId, authorId: userId, authorUsername: 'Alice', displayName: 'Alice', content: 'question', createdAt: 1, isSelf: false };
const draft = (): DraftPrompt => ({
  systemInstruction: 'Reply',
  material: { messages: [{ id: messageId, at: '2026-09-14T00:00:00.000Z', authorId: userId, content: 'question' }] },
  images: [],
  retrievedFacts: [],
  sourceMessages: [],
});
const context = (): ReplyContext => ({ guildId: 'g', channelId: 'c', requesterIsController: false, windowMessages: [windowMessage], taggedMessage: {
  id: messageId, content: 'raw request', author: { id: userId }, channel: {}, guild: { channels: { cache: new Map() } },
} as unknown as Message });

/** One turn as the runner hands it over: the raw message, plus the calls read out of it. */
const answer = (text = 'odpověď', calls: Array<{ name: string; id?: string; args?: Record<string, unknown> }> = []) => {
  const toolCalls = calls.map((call, index) => ({ id: call.id ?? `call-${index}`, name: call.name, args: call.args ?? {} }));
  return {
    message: {
      role: 'assistant' as const,
      content: text || null,
      tool_calls: toolCalls.map((call) => ({
        id: call.id, type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
      // What the provider requires echoed back unchanged.
      reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }],
    },
    text,
    toolCalls,
  };
};

const sentMessages = (call: number) => m.chat.mock.calls[call][1].messages;
const toolResults = (call: number) => sentMessages(call)
  .filter((entry: { role: string }) => entry.role === 'tool')
  .map((entry: { tool_call_id: string; content: string }) => [entry.tool_call_id, JSON.parse(entry.content)]);

describe('the reply protocol', () => {
  beforeEach(() => {
    m.canExtract.mockReturnValue(true); m.searchFacts.mockResolvedValue([]); m.fetchOlder.mockResolvedValue([]);
    m.recall.mockResolvedValue([]);
    m.addFacts.mockResolvedValue(['saved']); m.deleteFact.mockResolvedValue(true); m.runTool.mockResolvedValue({ ok: true });
    m.collectTools.mockReturnValue([{ pluginId: 'example', tool: { name: 'assess' }, declaration: { name: 'example__assess', description: 'Assess', parameters: {} } }]);
    m.chat.mockReset(); m.chat.mockResolvedValue(answer());
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('sends the material first and asks its own task list', async () => {
    await generateReply(draft(), context());
    const [task, request] = m.chat.mock.calls[0];
    expect(task).toBe('reply');
    expect(request.system).toBe('Reply');
    expect(JSON.parse(request.messages[0].content).messages[0].id).toBe(messageId);
    expect(request.toolChoice).toBe('auto');
  });

  it('executes mixed tool calls, echoes the model turn back untouched, and pairs each result with its call', async () => {
    const first = answer('', [{ name: 'list_people', id: 'people' }, { name: 'example__assess', id: 'score', args: { score: 5 } }]);
    m.chat.mockResolvedValueOnce(first);
    await generateReply(draft(), context());

    expect(m.runTool).toHaveBeenCalledTimes(1);
    // Exactly as it arrived: the reasoning it carries is refused if rebuilt.
    expect(sentMessages(1)[1]).toBe(first.message);
    expect(toolResults(1)).toEqual([
      ['people', expect.objectContaining({ people: expect.any(Array) })],
      ['score', expect.objectContaining({ ok: true })],
    ]);
  });

  it('stops as soon as the message is written and everything it called was fire-and-forget', async () => {
    m.collectTools.mockReturnValue([{
      pluginId: 'example', tool: { name: 'assess', effect: true },
      declaration: { name: 'example__assess', description: 'Assess', parameters: {} },
    }]);
    m.chat.mockResolvedValueOnce(answer('čau', [{ name: 'example__assess' }]));

    expect((await generateReply(draft(), context())).text).toBe('čau');
    // No second turn: it would only invite the model to narrate what it just did.
    expect(m.chat).toHaveBeenCalledTimes(1);
    expect(m.runTool).toHaveBeenCalledTimes(1);
  });

  it('asks again when a tool it called owes it an answer', async () => {
    m.chat.mockResolvedValueOnce(answer('čau', [{ name: 'list_people' }]));
    await generateReply(draft(), context());
    expect(m.chat).toHaveBeenCalledTimes(2);
  });

  it('passes one frozen authoritative invocation through discovery and execution', async () => {
    const ctx = context(); ctx.requesterIsController = true;
    m.chat.mockResolvedValueOnce(answer('', [{ name: 'example__assess', args: { score: 5 } }]));
    await generateReply(draft(), ctx);

    const invocation = m.collectTools.mock.calls[0][0];
    expect(invocation).toEqual({
      guildId: 'g', channelId: 'c', messageId, requesterId: userId,
      requesterIsController: true, requestContent: 'raw request',
    });
    expect(Object.isFrozen(invocation)).toBe(true);
    expect(m.runTool).toHaveBeenCalledWith(expect.any(Object), { score: 5 }, invocation);
  });

  it('executes two saves and pairs repeated plugin calls with their own results', async () => {
    m.runTool.mockResolvedValueOnce({ value: 'first' }).mockResolvedValueOnce({ value: 'second' });
    m.chat.mockResolvedValueOnce(answer('', [
      { name: 'save_fact', id: 'a', args: { text: 'One' } }, { name: 'save_fact', id: 'b', args: { text: 'Two' } },
      { name: 'example__assess', id: 'c' }, { name: 'example__assess', id: 'd' },
    ]));
    await generateReply(draft(), context());

    expect(m.addFacts).toHaveBeenCalledTimes(2);
    const results = Object.fromEntries(toolResults(1));
    expect(results.c.value).toBe('first');
    expect(results.d.value).toBe('second');
  });

  it('does not delete the original if saving the replacement fails', async () => {
    const data = draft(); data.retrievedFacts = [{ id: 'old' } as never];
    m.addFacts.mockRejectedValueOnce(new Error('outage'));
    m.chat.mockResolvedValueOnce(answer('', [{ name: 'delete_fact', args: { factId: 'old' } }, { name: 'save_fact', args: { text: 'new' } }]));
    await generateReply(data, context());
    expect(m.deleteFact).not.toHaveBeenCalled();
  });

  it('does not delete a stable ID already updated by save_fact', async () => {
    const data = draft(); data.retrievedFacts = [{ id: 'old' } as never];
    m.addFacts.mockResolvedValueOnce(['old']);
    m.chat.mockResolvedValueOnce(answer('', [{ name: 'delete_fact', args: { factId: 'old' } }, { name: 'save_fact', args: { text: 'new' } }]));
    await generateReply(data, context());
    expect(m.deleteFact).not.toHaveBeenCalled();
  });

  it('rejects memory changes when channel permission is off, even unsolicited calls', async () => {
    m.canExtract.mockReturnValue(false);
    m.chat.mockResolvedValueOnce(answer('', [{ name: 'save_fact', args: { text: 'private' } }]));
    await generateReply(draft(), context());

    expect(m.addFacts).not.toHaveBeenCalled();
    expect(m.chat.mock.calls[0][1].tools.map((tool: { name: string }) => tool.name)).not.toContain('save_fact');
  });

  it('allows a quoted older message as a reply target and links it by id', async () => {
    const old = '33333333333333333';
    const ctx = context(); ctx.quotedMessages = [{ ...windowMessage, id: old }];
    m.chat.mockResolvedValueOnce(answer('', [{ name: 'reply_to', args: { messageId: old } }]));
    m.chat.mockResolvedValueOnce(answer(`it was here <link:${old}>`));

    const result = await generateReply(draft(), ctx);
    expect(result.replyToMessageId).toBe(old);
    // The bot builds the URL; the model only ever names the message.
    expect(result.text).toBe(`it was here https://discord.com/channels/g/c/${old}`);
  });

  it('reports skipped over-budget calls honestly', async () => {
    m.chat.mockResolvedValueOnce(answer('', Array.from({ length: 25 }, (_, index) => ({ name: 'example__assess', id: `call-${index}` }))));
    await generateReply(draft(), context());

    expect(m.runTool).toHaveBeenCalledTimes(10);
    const results = toolResults(1).map(([, result]: [string, { error?: string }]) => result);
    expect(results.slice(10).every((result: { error?: string }) => result.error)).toBe(true);
  });

  it('keeps same-turn prose if the followup is tool narration', async () => {
    m.chat.mockResolvedValueOnce(answer('čau', [{ name: 'example__assess' }])).mockResolvedValueOnce(answer('all done'));
    expect((await generateReply(draft(), context())).text).toBe('čau');
  });

  it('says whether a lost reply was never written or was emptied afterwards', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Nothing came back at all.
    m.chat.mockResolvedValue(answer(''));
    expect((await generateReply(draft(), context())).text).toBe('');
    expect(warn.mock.calls.flat().join(' ')).toContain('produced no text at all');

    // Something came back and the sanitisers took all of it: a different bug,
    // in a different place, and the log has to say which.
    warn.mockClear();
    m.chat.mockReset();
    m.chat.mockResolvedValueOnce(answer('[replying to id=1549100564241981512]'));
    expect((await generateReply(draft(), context())).text).toBe('');
    const emptied = warn.mock.calls.flat().join(' ');
    expect(emptied).toContain('emptied after generation');
    expect(emptied).toContain('1549100564241981512');
  });

  it('logs the prose it drops as tool narration, so it can be told apart from silence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.chat.mockResolvedValueOnce(answer('čau', [{ name: 'example__assess' }])).mockResolvedValueOnce(answer('all done'));
    await generateReply(draft(), context());
    expect(warn.mock.calls.flat().join(' ')).toContain('all done');
  });

  // Whether to answer is settled by the topic call before this one runs, so the
  // reply has no silence tool to reach for — and nothing to name by mistake.
  it('offers no silence tool at all', async () => {
    m.chat.mockResolvedValue(answer('odpověď'));
    await generateReply(draft(), context());
    const offered = m.chat.mock.calls[0][1].tools.map((tool: { name: string }) => tool.name);
    expect(offered).not.toContain('stay_silent');
    expect(offered).toContain('reply_to');
  });

  // Observed: it posted the words "stay silent" to the channel. The model had
  // decided to say nothing and typed the decision instead of making it, which is
  // the loudest possible way to say nothing.
  it('stays silent when the model writes the words instead of calling the tool', async () => {
    for (const spoken of ['stay silent', 'stay_silent', 'Staying silent.', '*stays silent*', 'no reply']) {
      m.chat.mockReset();
      m.chat.mockResolvedValue(answer(spoken));
      const result = await generateReply(draft(), context());
      expect(result.silent, spoken).toBe(true);
      expect(result.text, spoken).toBe('');
    }
  });

  it('still posts a real reply that happens to talk about staying silent', async () => {
    m.chat.mockResolvedValue(answer('nah i could stay silent but ur wrong'));
    const result = await generateReply(draft(), context());
    expect(result.silent).toBe(false);
    expect(result.text).toBe('nah i could stay silent but ur wrong');
  });

  it('drops a bare tool name rather than posting it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.canExtract.mockReturnValue(true);
    m.chat.mockResolvedValue(answer('save_fact'));
    expect((await generateReply(draft(), context())).text).toBe('');
    expect(warn.mock.calls.flat().join(' ')).toContain('save_fact');
  });

  it('never falls back to prose claiming a rejected save succeeded', async () => {
    m.addFacts.mockResolvedValueOnce([]);
    m.chat.mockResolvedValue(answer(''));
    m.chat.mockResolvedValueOnce(answer('uložil jsem to', [{ name: 'save_fact', args: { text: 'new' } }]));
    expect((await generateReply(draft(), context())).text).toBe('');
  });

  it('bounds empty model responses and output length', async () => {
    m.chat.mockResolvedValue(answer(''));
    expect((await generateReply(draft(), context())).text).toBe('');
    expect(m.chat).toHaveBeenCalledTimes(3);

    m.chat.mockResolvedValue(answer('a'.repeat(2500)));
    expect((await generateReply(draft(), context())).text).toHaveLength(2000);
  });
});

describe('looking things up mid-reply', () => {
  const fact = (id: string, text: string) => ({
    id, text, distance: 0.1, foundBy: ['rule: the rule'],
    metadata: { guildId: 'g', channelId: 'c', messageIds: [], authorIds: [], referencedFactIds: [], timePeriodStart: 0, timePeriodEnd: 0, source: 'auto', createdAt: 0 },
  });

  it('offers reading history and searching memory as two separate tools', async () => {
    m.chat.mockResolvedValue(answer('odpověď'));
    await generateReply(draft(), context());
    const offered = m.chat.mock.calls[0][1].tools.map((tool: { name: string }) => tool.name);
    expect(offered).toContain('read_history');
    expect(offered).toContain('search_facts');
    // The one that did both is gone: reading messages and searching memory are
    // different questions, and pairing them meant paying for both every time.
    expect(offered).not.toContain('request_more_context');
  });

  it('runs every search in one call and hands back everything they found', async () => {
    m.recall.mockResolvedValueOnce([fact('f1', 'the hosting rule')]);
    m.chat
      .mockResolvedValueOnce(answer('', [{ name: 'search_facts', args: { searches: [
        { query: 'the hosting rule', type: 'rule', people: [] },
        { query: 'what Alice said', type: 'message', people: ['12345678901234567'] },
      ] } }]))
      .mockResolvedValueOnce(answer('odpověď'));
    await generateReply(draft(), context());

    expect(m.recall).toHaveBeenCalledTimes(1);
    expect(m.recall.mock.calls[0][0]).toEqual([
      { query: 'the hosting rule', type: 'rule', people: [] },
      { query: 'what Alice said', type: 'message', people: ['12345678901234567'] },
    ]);
    const [, result] = toolResults(1)[0];
    expect(result.additionalFacts[0]).toMatchObject({ id: 'f1', foundBy: ['rule: the rule'] });
  });

  it('drops a type nobody defined rather than filtering the search into nothing', async () => {
    m.chat
      .mockResolvedValueOnce(answer('', [{ name: 'search_facts', args: { searches: [{ query: 'anything', type: 'invented', people: [] }] } }]))
      .mockResolvedValueOnce(answer('odpověď'));
    await generateReply(draft(), context());
    expect(m.recall.mock.calls[0][0]).toEqual([{ query: 'anything', type: '', people: [] }]);
  });

  it('says so plainly when every search was empty, rather than searching for nothing', async () => {
    m.chat
      .mockResolvedValueOnce(answer('', [{ name: 'search_facts', args: { searches: [{ query: '  ', type: '', people: [] }] } }]))
      .mockResolvedValueOnce(answer('odpověď'));
    await generateReply(draft(), context());
    expect(m.recall).not.toHaveBeenCalled();
    expect(toolResults(1)[0][1].error).toContain('empty');
  });

  it('reads older messages without touching memory', async () => {
    m.fetchOlder.mockResolvedValueOnce([{ id: 'older', authorId: 'u', authorUsername: 'U', displayName: 'U', content: 'earlier', createdAt: 1, isSelf: false }]);
    m.chat
      .mockResolvedValueOnce(answer('', [{ name: 'read_history', args: { lookingFor: 'the earlier bit' } }]))
      .mockResolvedValueOnce(answer('odpověď'));
    await generateReply(draft(), context());
    const [, result] = toolResults(1)[0];
    expect(result.olderMessages).toHaveLength(1);
    expect(result).not.toHaveProperty('additionalFacts');
    expect(m.recall).not.toHaveBeenCalled();
  });
});
