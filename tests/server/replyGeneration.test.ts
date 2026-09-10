import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';
import type { DraftPrompt } from '@big-yahu/plugin-sdk';
import type { ReplyContext } from '../../src/server/ai/replyGeneration';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';

const m = vi.hoisted(() => ({
  generate: vi.fn(), addFacts: vi.fn(), deleteFact: vi.fn(), searchFacts: vi.fn(),
  canExtract: vi.fn(), runTool: vi.fn(), fetchOlder: vi.fn(), readChannel: vi.fn(),
  collectTools: vi.fn(),
}));
vi.mock('../../src/server/ai/generate', () => ({ generate: m.generate }));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({ getSettings: () => DEFAULT_SETTINGS }));
vi.mock('../../src/server/db/repositories/channelSettingsRepo', () => ({ canExtractFrom: m.canExtract }));
vi.mock('../../src/server/db/repositories/factsRepo', () => ({ addFacts: m.addFacts, deleteFact: m.deleteFact, searchFacts: m.searchFacts }));
vi.mock('../../src/server/db/repositories/cachedMessagesRepo', () => ({ cacheMessages: vi.fn(), getMessages: () => [] }));
vi.mock('../../src/server/plugins/engine', () => ({
  collectTools: m.collectTools,
  runTool: m.runTool,
}));
vi.mock('../../src/server/bot/channelAccess', () => ({ resolveReadableChannel: m.readChannel }));
vi.mock('../../src/server/ai/context', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/server/ai/context')>(),
  effectiveMaxDepth: () => 1, fetchOlderMessages: m.fetchOlder, listGuildPeople: () => 'Alice <@12345678901234567>',
}));
import { generateReply } from '../../src/server/ai/replyGeneration';

const messageId = '22222222222222222';
const userId = '12345678901234567';
const windowMessage = { id: messageId, authorId: userId, authorUsername: 'Alice', displayName: 'Alice', content: 'question', createdAt: 1, isSelf: false };
const draft = (): DraftPrompt => ({ conversation: [{ role: 'user', parts: [{ text: 'question' }] }], systemInstruction: 'Reply', retrievedFacts: [], sourceMessages: [] });
const context = (): ReplyContext => ({ guildId: 'g', channelId: 'c', requesterIsController: false, windowMessages: [windowMessage], taggedMessage: {
  id: messageId, content: 'raw request', author: { id: userId }, channel: {}, guild: { channels: { cache: new Map() } },
} as unknown as Message });
const reply = (text = 'odpověď', calls: Array<{ name: string; id?: string; args?: Record<string, unknown> }> = []) => ({
  functionCalls: calls,
  candidates: [{ content: { role: 'model', parts: [
    ...(text ? [{ text }] : []), ...calls.map((functionCall) => ({ functionCall, thoughtSignature: 'opaque-signature' })),
  ] } }],
});

describe('Gemini reply protocol', () => {
  beforeEach(() => {
    m.canExtract.mockReturnValue(true); m.searchFacts.mockResolvedValue([]); m.fetchOlder.mockResolvedValue([]);
    m.addFacts.mockResolvedValue(['saved']); m.deleteFact.mockResolvedValue(true); m.runTool.mockResolvedValue({ ok: true });
    m.collectTools.mockReturnValue([{ pluginId: 'example', tool: { name: 'assess' }, declaration: { name: 'example__assess' } }]);
    m.generate.mockReset(); m.generate.mockResolvedValue(reply());
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  it('executes mixed tool calls and preserves signatures, order and call IDs', async () => {
    const first = reply('', [{ name: 'list_people', id: 'people' }, { name: 'example__assess', id: 'score', args: { score: 5 } }]);
    m.generate.mockResolvedValueOnce(first);
    await generateReply(draft(), context());
    expect(m.runTool).toHaveBeenCalledTimes(1);
    const history = m.generate.mock.calls[1][0];
    expect(history[1]).toBe(first.candidates[0].content);
    expect(history[2].parts.map((p: any) => p.functionResponse)).toEqual([
      expect.objectContaining({ id: 'people', name: 'list_people', response: expect.objectContaining({ people: expect.any(String) }) }),
      expect.objectContaining({ id: 'score', name: 'example__assess', response: expect.objectContaining({ ok: true }) }),
    ]);
  });
  it('passes one frozen authoritative invocation through discovery and execution', async () => {
    const ctx = context(); ctx.requesterIsController = true;
    m.generate.mockResolvedValueOnce(reply('', [{ name: 'example__assess', args: { score: 5 } }]));
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
    m.generate.mockResolvedValueOnce(reply('', [
      { name: 'save_fact', args: { text: 'One' } }, { name: 'save_fact', args: { text: 'Two' } },
      { name: 'example__assess' }, { name: 'example__assess' },
    ]));
    await generateReply(draft(), context());
    expect(m.addFacts).toHaveBeenCalledTimes(2);
    const parts = m.generate.mock.calls[1][0][2].parts;
    expect(parts[2].functionResponse.response.value).toBe('first');
    expect(parts[3].functionResponse.response.value).toBe('second');
  });
  it('does not delete the original if saving the replacement fails', async () => {
    const data = draft(); data.retrievedFacts = [{ id: 'old' } as never];
    m.addFacts.mockRejectedValueOnce(new Error('outage'));
    m.generate.mockResolvedValueOnce(reply('', [{ name: 'delete_fact', args: { factId: 'old' } }, { name: 'save_fact', args: { text: 'new' } }]));
    await generateReply(data, context());
    expect(m.deleteFact).not.toHaveBeenCalled();
  });
  it('does not delete a stable ID already updated by save_fact', async () => {
    const data = draft(); data.retrievedFacts = [{ id: 'old' } as never];
    m.addFacts.mockResolvedValueOnce(['old']);
    m.generate.mockResolvedValueOnce(reply('', [{ name: 'delete_fact', args: { factId: 'old' } }, { name: 'save_fact', args: { text: 'new' } }]));
    await generateReply(data, context());
    expect(m.deleteFact).not.toHaveBeenCalled();
  });
  it('rejects memory changes when channel permission is off, even unsolicited calls', async () => {
    m.canExtract.mockReturnValue(false);
    m.generate.mockResolvedValueOnce(reply('', [{ name: 'save_fact', args: { text: 'private' } }]));
    await generateReply(draft(), context());
    expect(m.addFacts).not.toHaveBeenCalled();
    expect(m.generate.mock.calls[0][1].tools[0].functionDeclarations.map((x: any) => x.name)).not.toContain('save_fact');
  });
  it('allows a quoted older message as a reply target and source link', async () => {
    const old = '33333333333333333';
    const ctx = context(); ctx.quotedMessages = [{ ...windowMessage, id: old }];
    m.generate.mockResolvedValueOnce(reply('', [{ name: 'reply_to', args: { messageId: old } }]));
    m.generate.mockResolvedValueOnce(reply(`https://discord.com/channels/1/2/${old}`));
    const result = await generateReply(draft(), ctx);
    expect(result.replyToMessageId).toBe(old); expect(result.text).toContain(old);
  });
  it('reports skipped unknown and over-budget calls honestly', async () => {
    m.generate.mockResolvedValueOnce(reply('', Array.from({ length: 25 }, () => ({ name: 'example__assess' }))));
    await generateReply(draft(), context());
    expect(m.runTool).toHaveBeenCalledTimes(10);
    const results = m.generate.mock.calls[1][0][2].parts.map((p: any) => p.functionResponse.response);
    expect(results.slice(10).every((r: any) => r.error)).toBe(true);
  });
  it('keeps same-turn prose if the followup is tool narration', async () => {
    m.generate.mockResolvedValueOnce(reply('čau', [{ name: 'example__assess' }])).mockResolvedValueOnce(reply('all done'));
    expect((await generateReply(draft(), context())).text).toBe('čau');
  });
  it('honours silence while still executing the requested plugin tool', async () => {
    m.generate.mockResolvedValueOnce(reply('', [{ name: 'stay_silent' }, { name: 'example__assess' }]));
    expect((await generateReply(draft(), context())).silent).toBe(true);
    expect(m.runTool).toHaveBeenCalledTimes(1);
  });
  it('never falls back to prose claiming a rejected save succeeded', async () => {
    m.addFacts.mockResolvedValueOnce([]);
    m.generate.mockResolvedValue(reply(''));
    m.generate.mockResolvedValueOnce(reply('uložil jsem to', [{ name: 'save_fact', args: { text: 'new' } }]));
    expect((await generateReply(draft(), context())).text).toBe('');
  });
  it('bounds empty model responses and output length', async () => {
    m.generate.mockResolvedValue(reply(''));
    expect((await generateReply(draft(), context())).text).toBe('');
    expect(m.generate).toHaveBeenCalledTimes(3);
    m.generate.mockResolvedValue(reply('a'.repeat(2500)));
    expect((await generateReply(draft(), context())).text).toHaveLength(2000);
  });
});
