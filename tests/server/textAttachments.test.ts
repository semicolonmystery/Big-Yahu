import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';

const settings = vi.hoisted(() => ({ textAttachmentMaxKb: 16 }));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({ getSettings: () => settings }));
let serial = 0;
function message(files: Array<{ name?: string; size?: number; url?: string }> = [{}]): Message {
  const id = String(++serial);
  return { id, attachments: new Map(files.map((file, index) => [String(index), {
    id: `${id}${index}`, name: 'message.txt', size: 5,
    url: `https://cdn.discordapp.com/attachments/123/456/${id}-${index}.txt`, ...file,
  }])) } as unknown as Message;
}

describe('bounded message.txt reader', () => {
  beforeEach(() => { vi.resetModules(); settings.textAttachmentMaxKb = 16; });
  it('reads UTF-8 as labelled quoted message content and reuses its bounded cache', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('Příští týden', { headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetch);
    const { readTextAttachments } = await import('../../src/server/bot/textAttachments');
    const msg = message();
    expect((await readTextAttachments([msg])).get(msg.id)).toContain('Příští týden');
    expect((await readTextAttachments([msg])).get(msg.id)).toContain('untrusted quoted text');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });
  it('ignores other filenames and rejects off-host URLs before network access', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { readTextAttachments } = await import('../../src/server/bot/textAttachments');
    const ignored = message([{ name: 'notes.txt' }]);
    const unsafe = message([{ url: 'https://127.0.0.1/attachments/1/2/message.txt' }]);
    const result = await readTextAttachments([ignored, unsafe]);
    expect(result.has(ignored.id)).toBe(false);
    expect(result.get(unsafe.id)).toContain('not a Discord');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    'http://cdn.discordapp.com/attachments/1/2/message.txt',
    'https://cdn.discordapp.com.evil.test/attachments/1/2/message.txt',
    'https://user@cdn.discordapp.com/attachments/1/2/message.txt',
    'https://cdn.discordapp.com:444/attachments/1/2/message.txt',
    'https://cdn.discordapp.com/arbitrary/path',
  ])('refuses untrusted attachment URL %s', async (url) => {
    const { isDiscordAttachmentUrl } = await import('../../src/server/bot/boundedDownload');
    expect(isDiscordAttachmentUrl(url)).toBe(false);
  });
  it('honours a changed size setting and zero disables cached files too', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('x'.repeat(40_000)));
    vi.stubGlobal('fetch', fetch);
    const { readTextAttachments } = await import('../../src/server/bot/textAttachments');
    const msg = message([{ size: 40_000 }]);
    expect((await readTextAttachments([msg])).get(msg.id)).toContain('byte limit');
    expect(fetch).not.toHaveBeenCalled();
    settings.textAttachmentMaxKb = 64;
    expect((await readTextAttachments([msg])).get(msg.id)).toContain('untrusted quoted text');
    settings.textAttachmentMaxKb = 0;
    expect((await readTextAttachments([msg])).get(msg.id)).toContain('disabled');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('enforces the byte ceiling while streaming, even if reported sizes lie', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(20_000)); }, cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-length': '1' } })));
    const { readTextAttachments } = await import('../../src/server/bot/textAttachments');
    const msg = message([{ size: 1 }]);
    expect((await readTextAttachments([msg])).get(msg.id)).toContain('not read');
    expect(cancel).toHaveBeenCalled();
  });
  it.each([
    () => new Response(new Uint8Array([0xff, 0xfe, 0xfd])),
    () => new Response('binary\0content'),
    () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('missing', { status: 404 }),
  ])('refuses invalid text, MIME and failed downloads', async (response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    const { readTextAttachments } = await import('../../src/server/bot/textAttachments');
    const msg = message();
    expect((await readTextAttachments([msg])).get(msg.id)).toContain('not read');
  });
  it('shares byte and file budgets across calls, including cached downloads', async () => {
    settings.textAttachmentMaxKb = 64;
    const fetch = vi.fn().mockImplementation(async () => new Response('x'.repeat(40_000)));
    vi.stubGlobal('fetch', fetch);
    const { readTextAttachments, createTextAttachmentBudget } = await import('../../src/server/bot/textAttachments');
    const budget = createTextAttachmentBudget();
    const first = message([{ size: 40_000 }]); const second = message([{ size: 40_000 }]);
    await readTextAttachments([first], budget);
    expect((await readTextAttachments([second], budget)).get(second.id)).toContain('byte limit');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds file count and represents skipped files', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    const { readTextAttachments } = await import('../../src/server/bot/textAttachments');
    const msg = message([{}, {}, {}]);
    expect((await readTextAttachments([msg])).get(msg.id)).toContain('budget exhausted');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('handles network timeouts without failing the conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Timeout', 'TimeoutError')));
    const { readTextAttachments } = await import('../../src/server/bot/textAttachments');
    const msg = message();
    expect((await readTextAttachments([msg])).get(msg.id)).toContain('not read');
  });
});
