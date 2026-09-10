import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';
import { MessageType } from 'discord.js';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';

const m = vi.hoisted(() => ({
  extract: vi.fn(), generate: vi.fn(), cache: vi.fn(), facts: vi.fn(), sources: vi.fn(), log: vi.fn(),
  canExtract: vi.fn(), admit: vi.fn(), release: vi.fn(), stopTyping: vi.fn(), images: vi.fn(),
  before: vi.fn(), controller: vi.fn(), referenceWindow: vi.fn(), settings: vi.fn(),
}));
vi.mock('../../src/server/ai/topicExtraction', () => ({ extractTopic: m.extract }));
vi.mock('../../src/server/ai/replyGeneration', () => ({ generateReply: m.generate }));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({ getSettings: m.settings }));
vi.mock('../../src/server/db/repositories/channelSettingsRepo', () => ({ canExtractFrom: m.canExtract }));
vi.mock('../../src/server/db/repositories/controllersRepo', () => ({ isController: m.controller }));
vi.mock('../../src/server/db/repositories/factsRepo', () => ({ searchFacts: m.facts }));
vi.mock('../../src/server/db/repositories/cachedMessagesRepo', () => ({ cacheMessages: m.cache, getMessages: m.sources }));
vi.mock('../../src/server/db/repositories/replyLogRepo', () => ({ logReply: m.log }));
vi.mock('../../src/server/bot/replyAdmission', () => ({ admitReply: m.admit }));
vi.mock('../../src/server/bot/typing', () => ({ startTyping: () => m.stopTyping }));
vi.mock('../../src/server/bot/attachments', () => ({ imagePartsFor: m.images }));
vi.mock('../../src/server/bot/channelAccess', () => ({ readableChannelRoster: () => '', resolveReadableChannel: vi.fn() }));
vi.mock('../../src/server/plugins/engine', () => ({
  collectAnnotations: () => '', collectInstructions: () => [], runBeforeReply: m.before,
}));
vi.mock('../../src/server/ai/context', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/server/ai/context')>(), windowMessagesWithAttachments: m.referenceWindow,
}));
import { handleMention } from '../../src/server/bot/replyPipeline';

const window = { id: '22', authorId: '12345678901234567', authorUsername: 'Alice', displayName: 'Alice', content: 'question', createdAt: 1, isSelf: false };
function message() {
  const value = {
    id: '22', guildId: 'guild', channelId: 'public', type: MessageType.Default, reference: null,
    author: { id: window.authorId, username: 'Alice' },
    client: { user: { id: 'bot', username: 'bot', displayName: 'bot' } },
    guild: { members: { cache: new Map() }, channels: { cache: new Map() }, presences: { cache: new Map() } },
    channel: { isSendable: () => true, send: vi.fn().mockResolvedValue({ id: 'sent-elsewhere' }) },
    mentions: { users: new Map(), channels: new Map() }, reply: vi.fn().mockResolvedValue({ id: 'sent' }),
    fetchReference: vi.fn(),
  };
  return value;
}
describe('complete reply pipeline boundaries', () => {
  beforeEach(() => {
    m.settings.mockReturnValue({ ...DEFAULT_SETTINGS });
    m.extract.mockResolvedValue({ topic: { coreTopic: 'topic', whatTaggingMessageIsAbout: 'question' }, windowMessages: [window], discordMessages: [] });
    m.generate.mockResolvedValue({ text: 'answer', silent: false, savedFactIds: [], deletedFactIds: [], replyToMessageId: null });
    m.canExtract.mockReturnValue(true); m.admit.mockReturnValue(m.release); m.controller.mockReturnValue(false);
    m.facts.mockResolvedValue([]); m.sources.mockReturnValue([]);
    m.images.mockResolvedValue({ images: [], unseen: new Map() });
    m.before.mockImplementation(async ({ draftPrompt }) => ({ draftPrompt, skipReply: false }));
    m.referenceWindow.mockResolvedValue([{ ...window, id: 'old' }]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  it('answers and logs the sent message, then releases typing/admission', async () => {
    const msg = message(); await handleMention(msg as unknown as Message);
    expect(msg.reply).toHaveBeenCalledWith({ content: 'answer', allowedMentions: { parse: ['users'], repliedUser: true } });
    expect(m.log).toHaveBeenCalledWith(expect.objectContaining({ replyMessageId: 'sent', taggedMessageId: '22' }));
    expect(m.release).toHaveBeenCalledTimes(1); expect(m.stopTyping).toHaveBeenCalledTimes(1);
  });
  it('propagates the controller result as authoritative reply context', async () => {
    m.controller.mockReturnValueOnce(true);
    const msg = message(); await handleMention(msg as unknown as Message);
    expect(m.controller).toHaveBeenCalledWith(window.authorId);
    expect(m.generate.mock.calls[0][1]).toMatchObject({ requesterIsController: true });
  });
  it('rejects excess work before context/attachments/AI', async () => {
    m.admit.mockReturnValue(null);
    const msg = message(); await handleMention(msg as unknown as Message);
    expect(m.extract).not.toHaveBeenCalled(); expect(m.images).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({ content: DEFAULT_SETTINGS.rateLimitMessage }));
  });
  it('does not persist local private context or recall disabled-channel facts', async () => {
    m.canExtract.mockReturnValue(false);
    m.facts.mockResolvedValue([{ id: 'private', text: 'secret', metadata: { channelId: 'private', messageIds: [] } }]);
    const msg = message(); await handleMention(msg as unknown as Message);
    expect(m.cache).not.toHaveBeenCalled();
    expect(m.generate.mock.calls[0][0].retrievedFacts).toEqual([]);
  });
  it('passes the referenced old message and one shared attachment budget through', async () => {
    const msg = message(); Object.assign(msg, { type: MessageType.Reply, reference: { messageId: 'old' } });
    msg.fetchReference.mockResolvedValue({ id: 'old', author: { id: 'another' } });
    await handleMention(msg as unknown as Message);
    const ctx = m.generate.mock.calls[0][1];
    expect(ctx.quotedMessages[0].id).toBe('old');
    expect(ctx.attachmentBudget).toBe(m.extract.mock.calls[0][3]);
    expect(m.referenceWindow.mock.calls[0][1]).toBe(ctx.attachmentBudget);
  });
  it('does not dereference forwarded/pinned message references as replies', async () => {
    const msg = message(); Object.assign(msg, { reference: { messageId: 'foreign' } });
    await handleMention(msg as unknown as Message);
    expect(msg.fetchReference).not.toHaveBeenCalled();
  });
  it('marks an old quoted image as unseen when its only download fails', async () => {
    const { imagePartsFor } = await vi.importActual<typeof import('../../src/server/bot/attachments')>('../../src/server/bot/attachments');
    m.images.mockImplementationOnce(imagePartsFor);
    const download = vi.fn().mockRejectedValue(new Error('Image download failed'));
    vi.stubGlobal('fetch', download);
    const oldImage = {
      id: 'old', author: { id: 'another' }, embeds: [],
      attachments: new Map([['image', { contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/old.png' }]]),
    };
    const msg = message();
    Object.assign(msg, { type: MessageType.Reply, reference: { messageId: 'old' } });
    msg.fetchReference.mockResolvedValue(oldImage);
    m.referenceWindow.mockResolvedValueOnce([{ ...window, id: 'old', content: '' }]);
    await handleMention(msg as unknown as Message);
    expect(m.images).toHaveBeenCalledExactlyOnceWith([oldImage], DEFAULT_SETTINGS.maxImages);
    expect(download).toHaveBeenCalledTimes(1);
    const [draft, context] = m.generate.mock.calls[0];
    const prompt = draft.conversation[0].parts[0].text;
    expect(prompt.slice(prompt.indexOf('The message being replied to:'))).toContain('[image not shown]');
    expect(context.quotedMessages).toEqual([expect.objectContaining({ id: 'old', unseenImages: 1 })]);
    expect(draft.conversation[0].parts).toHaveLength(1);
  });
  it('marks recent and quoted images when vision is disabled without downloading either', async () => {
    const { imagePartsFor } = await vi.importActual<typeof import('../../src/server/bot/attachments')>('../../src/server/bot/attachments');
    m.images.mockImplementationOnce(imagePartsFor);
    m.settings.mockReturnValue({ ...DEFAULT_SETTINGS, visionEnabled: false });
    const download = vi.fn().mockRejectedValue(new Error('Vision must not download when disabled'));
    vi.stubGlobal('fetch', download);
    const imageMessage = (id: string) => ({
      id, author: { id: 'another' }, embeds: [],
      attachments: new Map([['image', { contentType: 'image/png', url: `https://cdn.discordapp.com/attachments/${id}.png` }]]),
    });
    const recentImage = imageMessage(window.id);
    const oldImage = imageMessage('old');
    m.extract.mockResolvedValueOnce({
      topic: { coreTopic: 'images', whatTaggingMessageIsAbout: 'pictures' },
      windowMessages: [{ ...window, content: '' }], discordMessages: [recentImage],
    });
    m.referenceWindow.mockResolvedValueOnce([{ ...window, id: 'old', content: '' }]);
    const msg = message();
    Object.assign(msg, { type: MessageType.Reply, reference: { messageId: 'old' } });
    msg.fetchReference.mockResolvedValue(oldImage);
    await handleMention(msg as unknown as Message);
    expect(m.images).toHaveBeenCalledExactlyOnceWith([recentImage, oldImage], 0);
    expect(download).not.toHaveBeenCalled();
    const [draft, context] = m.generate.mock.calls[0];
    expect(draft.conversation[0].parts[0].text.match(/\[image not shown\]/g)).toHaveLength(2);
    expect(context.quotedMessages[0]).toMatchObject({ id: 'old', unseenImages: 1 });
    expect(draft.conversation[0].parts).toHaveLength(1);
  });
  it('honours deliberate silence and plugin skip without writing a reply log', async () => {
    m.generate.mockResolvedValueOnce({ text: '', silent: true });
    const msg = message(); await handleMention(msg as unknown as Message);
    expect(msg.reply).not.toHaveBeenCalled(); expect(m.log).not.toHaveBeenCalled();
    m.before.mockImplementationOnce(async ({ draftPrompt }) => ({ draftPrompt, skipReply: true }));
    await handleMention(message() as unknown as Message);
    expect(m.generate).toHaveBeenCalledTimes(1);
  });
  it('sends the configured fallback on empty or failed generation and releases resources', async () => {
    const msg = message(); m.generate.mockResolvedValueOnce({ text: '', silent: false });
    await handleMention(msg as unknown as Message);
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({ content: DEFAULT_SETTINGS.overloadMessage }));
    m.extract.mockRejectedValueOnce(new Error('unavailable'));
    await handleMention(message() as unknown as Message);
    expect(m.release).toHaveBeenCalledTimes(2); expect(m.stopTyping).toHaveBeenCalledTimes(2);
  });
  it('does not contradict a delivered answer when post-send bookkeeping fails', async () => {
    // logReply runs after the reply is already in the channel, so a failing
    // write used to produce a correct answer followed by the overload message.
    m.log.mockImplementationOnce(() => { throw new Error('reply_log is unavailable'); });
    const msg = message(); await handleMention(msg as unknown as Message);
    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'answer' }));
    expect(m.release).toHaveBeenCalledTimes(1); expect(m.stopTyping).toHaveBeenCalledTimes(1);
  });
  it('still answers when generation fails before anything is sent', async () => {
    m.generate.mockRejectedValueOnce(new Error('unexpected'));
    const msg = message(); await handleMention(msg as unknown as Message);
    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({ content: DEFAULT_SETTINGS.overloadMessage }));
  });
  it('keeps allowed-mentions restrictions on alternative reply targets', async () => {
    m.generate.mockResolvedValueOnce({ text: 'answer', silent: false, savedFactIds: [], deletedFactIds: [], replyToMessageId: 'old' });
    const msg = message(); await handleMention(msg as unknown as Message);
    expect(msg.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      reply: { messageReference: 'old', failIfNotExists: false }, allowedMentions: { parse: ['users'], repliedUser: true },
    }));
  });
});
