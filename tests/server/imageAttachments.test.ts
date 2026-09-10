import { describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';
import { imagePartsFor } from '../../src/server/bot/attachments';

function messages(count: number, mime = 'image/png'): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index), embeds: [], attachments: new Map([['image', {
      contentType: mime, proxyURL: `https://media.discordapp.net/attachments/1/2/${index}.png`,
    }]]),
  } as unknown as Message));
}

describe('image attachment limits', () => {
  it('spreads capped images across the window and marks everything omitted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('png', { headers: { 'content-type': 'image/png' } })));
    const result = await imagePartsFor(messages(5), 3);
    expect(result.images.map((image) => image.messageId)).toEqual(['0', '2', '4']);
    expect([...result.unseen.keys()]).toEqual(['1', '3']);
  });
  it('never downloads images with a zero budget', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await imagePartsFor(messages(2), 0);
    expect(result.images).toEqual([]); expect(result.unseen.size).toBe(2); expect(fetch).not.toHaveBeenCalled();
  });
  it('converts GIF through the Discord image proxy and deduplicates URLs', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('png', { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetch);
    const [msg] = messages(1, 'image/gif');
    const result = await imagePartsFor([msg, msg], 4);
    expect(result.images).toHaveLength(1); expect(fetch.mock.calls[0][0]).toContain('format=png');
  });
  it('skips a stream exceeding the byte allowance and cancels it', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6 * 1024 * 1024)); }, cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'image/png' } })));
    const result = await imagePartsFor(messages(1), 1);
    expect(result.images).toEqual([]); expect(result.unseen.get('0')).toBe(1); expect(cancel).toHaveBeenCalled();
  });
  it('reserves a total request byte budget before parallel downloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('x', {
      headers: { 'content-type': 'image/png', 'content-length': String(3 * 1024 * 1024) },
    })));
    const result = await imagePartsFor(messages(4), 4);
    expect(result.images).toHaveLength(0); expect(result.unseen.size).toBe(4);
  });
  it('does not fetch image embed URLs outside the Discord proxy', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const msg = { id: 'x', attachments: new Map(), embeds: [{ image: { url: 'http://127.0.0.1/secret' } }] } as unknown as Message;
    const result = await imagePartsFor([msg], 1);
    expect(result.images).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
});

describe('one rule decides what Discord URL is safe to fetch', () => {
  it('rejects an explicit non-443 port on both download paths', async () => {
    const { isDiscordImageUrl, isDiscordAttachmentUrl } = await import('../../src/server/bot/boundedDownload');
    // The image path omitted this check while the attachment path had it, so a
    // pinned hostname on a filtered port was still dialled and hung.
    expect(isDiscordImageUrl('https://cdn.discordapp.com:444/x.png')).toBe(false);
    expect(isDiscordAttachmentUrl('https://cdn.discordapp.com:444/attachments/1/2/message.txt')).toBe(false);
    expect(isDiscordImageUrl('https://cdn.discordapp.com:443/x.png')).toBe(true);
  });

  it('rejects other hosts, other schemes and embedded credentials', async () => {
    const { isDiscordImageUrl } = await import('../../src/server/bot/boundedDownload');
    for (const url of [
      'http://cdn.discordapp.com/x.png',
      'https://evil.example.com/x.png',
      'https://cdn.discordapp.com.evil.example.com/x.png',
      'https://user:pass@cdn.discordapp.com/x.png',
      'https://127.0.0.1/x.png',
      'not a url at all',
    ]) expect(isDiscordImageUrl(url)).toBe(false);
  });

  it('accepts the embed proxy hosts images actually arrive on', async () => {
    const { isDiscordImageUrl } = await import('../../src/server/bot/boundedDownload');
    expect(isDiscordImageUrl('https://media.discordapp.net/attachments/1/2/x.png')).toBe(true);
    expect(isDiscordImageUrl('https://images-ext-1.discordapp.net/external/abc/x.png')).toBe(true);
    // Only attachments proper are read as text, so the proxy is not one of them.
    const { isDiscordAttachmentUrl } = await import('../../src/server/bot/boundedDownload');
    expect(isDiscordAttachmentUrl('https://images-ext-1.discordapp.net/external/abc/x.txt')).toBe(false);
  });
});
