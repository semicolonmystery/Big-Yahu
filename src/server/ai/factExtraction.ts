import type { Message, TextBasedChannel } from 'discord.js';
import { markUnseenImages, mentionRoster, runEscalatableExtraction, toWindowMessage } from './context';
import { extractionSchema } from './schemas';
import type { ExtractionResult } from './schemas';
import { buildFactExtractionInstruction } from './prompts/systemInstructions';
import { addFacts } from '../db/repositories/factsRepo';
import { cacheMessages } from '../db/repositories/cachedMessagesRepo';
import { advanceCheckpoint, getCheckpoint } from '../db/repositories/checkpointRepo';
import { collectExtractionAnnotations, runOnHourlyCheck } from '../plugins/engine';
import { getSettings } from '../db/repositories/settingsRepo';
import { formatNow } from '@shared/constants';
import { normaliseFactMentions } from '@shared/discord';
import { imagePartsFor } from '../bot/attachments';

const FETCH_LIMIT = 100;

function isTextChannel(channel: TextBasedChannel): boolean {
  return 'messages' in channel;
}

/** Walks forward from the checkpoint in pages, oldest first. */
async function fetchSinceCheckpoint(channel: TextBasedChannel, after: string | null): Promise<Message[]> {
  const collected: Message[] = [];
  let cursor = after;

  for (;;) {
    const batch = await channel.messages.fetch(
      cursor ? { after: cursor, limit: FETCH_LIMIT } : { limit: FETCH_LIMIT },
    );
    if (batch.size === 0) break;

    const page = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    collected.push(...page);

    // Without a checkpoint we take one page only, rather than the whole channel history.
    if (!cursor || batch.size < FETCH_LIMIT) break;
    cursor = page[page.length - 1].id;
  }

  return collected.filter((message) => !message.author.bot && message.content.trim().length > 0);
}

/**
 * Extracts facts from everything said in one channel since the last check.
 * Channels are always processed separately — a prompt never mixes them.
 */
export async function runExtractionForChannel(channel: TextBasedChannel, guildId: string): Promise<number> {
  if (!isTextChannel(channel)) return 0;

  const checkpoint = getCheckpoint(channel.id);
  const messages = await fetchSinceCheckpoint(channel, checkpoint?.lastMessageId ?? null);

  if (messages.length === 0) {
    advanceCheckpoint(channel.id, null);
    return 0;
  }

  const newest = messages[messages.length - 1];
  await runOnHourlyCheck({ channelId: channel.id, guildId, newMessages: messages });

  cacheMessages(
    messages.map((message) => ({
      messageId: message.id,
      channelId: channel.id,
      guildId,
      authorId: message.author.id,
      authorUsername: message.author.username,
      content: message.content,
      messageCreatedAt: message.createdTimestamp,
    })),
  );

  // A picture is often the whole point of the message it was posted in, and
  // without it the extraction reads those messages as empty and remembers
  // nothing about them. Whatever does not fit the budget is marked in the
  // transcript rather than dropped silently.
  const settings = getSettings();
  const { images, unseen } = settings.visionEnabled
    ? await imagePartsFor(messages, settings.maxImages)
    : { images: [], unseen: new Map<string, number>() };

  const windowMessages = markUnseenImages(messages.map(toWindowMessage), unseen);

  const imageNote =
    images.length > 0
      ? ` ${images.length} image(s) from these messages are attached, in order: `
        + `${images.map((image, index) => `image ${index + 1} from [id=${image.messageId}]`).join(', ')}. `
        + 'Read them as part of the message they belong to. A line marked "image not shown" had one you '
        + 'were not given: do not guess at what it was.'
      : '';

  // Plugins may put background beside the window — who "he" is, what "the thing"
  // refers to. Its own hook, not annotateContext: reaching the pass that writes
  // permanent memory is something a plugin has to opt into knowingly.
  const background = await collectExtractionAnnotations({
    channelId: channel.id,
    guildId,
    messages: windowMessages.map((windowMessage) => ({
      id: windowMessage.id,
      authorId: windowMessage.authorId,
      content: windowMessage.content,
      createdAt: windowMessage.createdAt,
    })),
  });

  const result = await runEscalatableExtraction<ExtractionResult>({
    schema: extractionSchema,
    systemInstruction: buildFactExtractionInstruction(formatNow(settings.timezone)),
    task: `Extract the facts worth remembering from this channel.${imageNote}`
      + (background ? `\n\n${background}` : ''),
    windowMessages,
    anchorMessage: newest,
    guildId,
    imageParts: images.map((image) => image.part),
  });

  const knownIds = new Set(windowMessages.map((message) => message.id));
  const authorByMessageId = new Map(windowMessages.map((message) => [message.id, message.authorId]));
  // Facts outlive the names people are using today, so anyone named in one is
  // stored as a mention instead.
  const roster = mentionRoster(windowMessages);
  const created = await addFacts(
    result.facts
      .map((fact) => {
        const messageIds = fact.messageIds.filter((id) => knownIds.has(id));
        const authorIds = messageIds.map((id) => authorByMessageId.get(id)).filter((id) => id !== undefined);
        return {
          text: normaliseFactMentions(fact.text, roster),
          messageIds,
          authorIds: [...new Set(authorIds)],
          guildId,
          channelId: channel.id,
          source: 'auto' as const,
          timePeriodStart: windowMessages[0].createdAt,
          timePeriodEnd: newest.createdTimestamp,
        };
      })
      .filter((candidate) => candidate.messageIds.length > 0),
  );

  advanceCheckpoint(channel.id, newest.id);
  return created.length;
}
