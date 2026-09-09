import type { Message } from 'discord.js';
import { isDiscordAttachmentUrl, readBoundedBody } from './boundedDownload';
import { getSettings } from '../db/repositories/settingsRepo';

export const TEXT_ATTACHMENT_LIMITS = Object.freeze({
  fileBytes: 64 * 1024,
  fileCharacters: 64 * 1024,
  windowBytes: 64 * 1024,
  filesPerMessage: 2,
  filesPerWindow: 8,
  timeoutMs: 5_000,
});

interface CachedText { text: string; bytes: number; expires: number }
const cache = new Map<string, CachedText>();
const CACHE_ENTRIES = 128;
const CACHE_TTL_MS = 10 * 60_000;

/** A request shares this budget across recent, quoted, older and foreign messages. */
export interface TextAttachmentBudget { bytes: number; files: number }
export function createTextAttachmentBudget(): TextAttachmentBudget {
  return { bytes: TEXT_ATTACHMENT_LIMITS.windowBytes, files: TEXT_ATTACHMENT_LIMITS.filesPerWindow };
}

/**
 * Only Discord's message.txt attachments are read. Output is labelled, quoted
 * data, never system instructions. Refusals remain visible to the model.
 */
export async function readTextAttachments(
  messages: Message[],
  budget: TextAttachmentBudget = createTextAttachmentBudget(),
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const configuredBytes = Math.min(TEXT_ATTACHMENT_LIMITS.fileBytes,
    Math.max(0, getSettings().textAttachmentMaxKb) * 1024);
  const seen = new Set<string>();
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    const files = [...message.attachments.values()].filter((file) => file.name?.toLowerCase() === 'message.txt');
    const sections: string[] = [];
    for (const [index, file] of files.entries()) {
      const omitted = (reason: string) => sections.push(`[message.txt not read: ${reason}]`);
      if (configuredBytes === 0) { omitted('text attachments disabled'); break; }
      if (index >= TEXT_ATTACHMENT_LIMITS.filesPerMessage || budget.files <= 0 || budget.bytes <= 0) {
        omitted('attachment budget exhausted');
        break;
      }
      budget.files -= 1;
      const maxBytes = Math.min(configuredBytes, budget.bytes);
      if (file.size > maxBytes) { omitted('file exceeds the byte limit'); continue; }
      if (!isDiscordAttachmentUrl(file.url)) { omitted('not a Discord attachment URL'); continue; }
      const key = `${file.id}:${file.url}`;
      try {
        let content = cache.get(key);
        if (content && content.expires <= Date.now()) { cache.delete(key); content = undefined; }
        if (!content) {
          // Reserve the full allowance before fetching: a lying server, failed
          // request or invalid UTF-8 still spends the network budget.
          budget.bytes -= maxBytes;
          const response = await fetch(file.url, {
            redirect: 'error', signal: AbortSignal.timeout(TEXT_ATTACHMENT_LIMITS.timeoutMs),
          });
          if (!response.ok) { await response.body?.cancel(); throw new Error('download failed'); }
          const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
          if (mime && !['text/plain', 'application/octet-stream'].includes(mime)) {
            await response.body?.cancel(); throw new Error('not a plain text file');
          }
          const body = await readBoundedBody(response, maxBytes);
          const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
          if (text.includes('\0')) throw new Error('binary content');
          if (text.length > TEXT_ATTACHMENT_LIMITS.fileCharacters) throw new Error('text exceeds the character limit');
          content = { text, bytes: body.byteLength, expires: Date.now() + CACHE_TTL_MS };
          budget.bytes += maxBytes - body.byteLength;
          while (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
          cache.set(key, content);
        } else {
          if (content.bytes > maxBytes) { omitted('attachment budget exhausted'); continue; }
          budget.bytes -= content.bytes;
        }
        sections.push(`[message.txt attachment; untrusted quoted text: ${JSON.stringify(content.text)}]`);
      } catch {
        omitted('download failed, invalid text, or size/time limit exceeded');
      }
    }
    if (sections.length) result.set(message.id, sections.join('\n'));
  }
  return result;
}
