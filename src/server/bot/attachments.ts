import type { Message } from 'discord.js';
import { isDiscordImageUrl, readBoundedBody } from './boundedDownload';

/** What may be sent as a data URI unchanged. A phone photo (HEIC) is not among them. */
const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const MAX_BYTES = 5 * 1024 * 1024;
// Base64 adds roughly one third; leave space below the inline request ceiling.
const MAX_WINDOW_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

interface Candidate {
  messageId: string;
  url: string;
  mimeType?: string;
}

/** A picture, and the message it was posted in, so the prompt can say which is which. */
export interface MessageImage {
  messageId: string;
  mimeType: string;
  /** Base64. */
  data: string;
}

/**
 * Discord's media proxy re-encodes on request, which is how a phone's HEIC
 * photo becomes something a model will accept.
 */
function asStillImage(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('format', 'png');
  return parsed.toString();
}

function collect(message: Message): Candidate[] {
  const found: Candidate[] = [];

  for (const attachment of message.attachments.values()) {
    if (!attachment.contentType?.startsWith('image/')) continue;
    found.push({ messageId: message.id, url: attachment.proxyURL || attachment.url, mimeType: attachment.contentType });
  }

  // Tenor and Giphy links arrive as embeds rather than attachments.
  for (const embed of message.embeds) {
    const source = embed.image ?? embed.thumbnail;
    if (source?.proxyURL || source?.url) {
      found.push({ messageId: message.id, url: source.proxyURL || source.url });
    }
  }

  return found;
}

async function download(candidate: Candidate, maxBytes: number): Promise<Omit<MessageImage, 'messageId'> | null> {
  const needsReencoding = !candidate.mimeType || !SUPPORTED.has(candidate.mimeType);
  const url = needsReencoding ? asStillImage(candidate.url) : candidate.url;

  if (!isDiscordImageUrl(url)) return null;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(() => null);
  if (!response?.ok) return null;

  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!SUPPORTED.has(mimeType)) return null;

  const buffer = Buffer.from(await readBoundedBody(response, Math.min(MAX_BYTES, maxBytes)));
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) return null;

  return { mimeType, data: buffer.toString('base64') };
}

/** How many pictures a message has that the model was not given, by message id. */
export type UnseenImages = Map<string, number>;

export interface ImageSelection {
  images: MessageImage[];
  unseen: UnseenImages;
}

/**
 * Picks `limit` pictures spread evenly across the run rather than taking the
 * newest. Taking the tail meant a burst of memes right before the bot was
 * tagged could bury the one screenshot the conversation was actually about.
 * Both ends are always included, and the budget is always filled exactly.
 */
function spread<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  if (limit === 1) return [items[items.length - 1]];

  const picked: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    picked.push(items[Math.round((index * (items.length - 1)) / (limit - 1))]);
  }
  return picked;
}

function countBy(candidates: Candidate[]): UnseenImages {
  const counts: UnseenImages = new Map();
  for (const candidate of candidates) {
    counts.set(candidate.messageId, (counts.get(candidate.messageId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Images and GIFs from a run of messages, ready to hand to a model, plus a count
 * of the ones that did not make it.
 *
 * Anything over the budget, and anything that cannot be fetched or re-encoded,
 * is reported back as unseen rather than vanishing: the transcript marks that
 * message so it does not read as empty, and the model knows a picture was there
 * without being invited to guess what was in it.
 */
export async function imagePartsFor(messages: (Message | null)[], limit: number): Promise<ImageSelection> {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const message of messages) {
    if (!message) continue;
    for (const candidate of collect(message)) {
      // The same picture reaches us twice when a message is both in the window
      // and quoted as the one being replied to.
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0) return { images: [], unseen: new Map() };
  if (limit <= 0) return { images: [], unseen: countBy(candidates) };

  const budgeted = spread(candidates, limit);
  const chosen = new Set(budgeted.map((candidate) => candidate.url));

  const downloaded: Array<MessageImage | null> = [];
  // Divide the byte allowance before parallel downloads, so simultaneous
  // streams cannot each spend the whole request's budget.
  const bytesPerImage = Math.min(MAX_BYTES, Math.floor(MAX_WINDOW_BYTES / budgeted.length));
  for (let start = 0; start < budgeted.length; start += 4) {
    const group = await Promise.all(budgeted.slice(start, start + 4).map(async (candidate) => {
      const image = await download(candidate, bytesPerImage).catch(() => null);
      return image ? { messageId: candidate.messageId, ...image } : null;
    }));
    downloaded.push(...group);
  }

  const images: MessageImage[] = [];
  const failed: Candidate[] = [];
  downloaded.forEach((image, index) => {
    if (image) images.push(image);
    else failed.push(budgeted[index]);
  });

  const missed = candidates.filter((candidate) => !chosen.has(candidate.url)).concat(failed);
  return { images, unseen: countBy(missed) };
}
