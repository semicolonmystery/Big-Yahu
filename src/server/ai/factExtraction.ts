import type { Message, TextBasedChannel } from 'discord.js';
import { markUnseenImages, mentionRoster, runEscalatableExtraction, toWindowMessage } from './context';
import { extractionSchema } from './schemas';
import type { ExtractionResult } from './schemas';
import { buildFactExtractionInstruction } from './prompts/build';
import { addFacts } from '../db/repositories/factsRepo';
import { cacheMessages } from '../db/repositories/cachedMessagesRepo';
import { advanceCheckpoint, getCheckpoint } from '../db/repositories/checkpointRepo';
import { collectExtractionAnnotations, runOnHourlyCheck } from '../plugins/engine';
import { getSettings } from '../db/repositories/settingsRepo';
import { normaliseFactMentions } from '@shared/discord';
import { imagePartsFor } from '../bot/attachments';
import { createTextAttachmentBudget, readTextAttachments } from '../bot/textAttachments';

const FETCH_LIMIT = 100;
const MAX_PAGES_PER_RUN = 5;
const runningChannels = new Set<string>();

function isTextChannel(channel: TextBasedChannel): boolean {
  return 'messages' in channel;
}

/**
 * Process bounded pages and commit each checkpoint only after its facts save.
 * A busy channel cannot grow one prompt without bound or hold up every other
 * channel indefinitely; remaining pages are picked up at the next check.
 */
export async function runExtractionForChannel(channel: TextBasedChannel, guildId: string): Promise<number> {
  if (!isTextChannel(channel) || runningChannels.has(channel.id)) return 0;
  runningChannels.add(channel.id);
  try {
    let cursor = getCheckpoint(channel.id)?.lastMessageId ?? null;
    let created = 0;
    for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_RUN; pageIndex += 1) {
      const batch = await channel.messages.fetch(
        cursor ? { after: cursor, limit: FETCH_LIMIT } : { limit: FETCH_LIMIT },
      );
      const page = [...batch.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
      const newest = page.at(-1);
      if (!newest) {
        advanceCheckpoint(channel.id, null);
        break;
      }
      // Also protect against an unexpected repeated API page.
      if (cursor && BigInt(newest.id) <= BigInt(cursor)) break;
      const messages = page.filter((message) => !message.author.bot);
      if (messages.length > 0) created += await extractPage(channel, guildId, messages);

      // Advance past bot-only and attachment-only pages as well. Only a failed
      // extraction leaves a page pending for retry.
      advanceCheckpoint(channel.id, newest.id);
      if (!cursor || batch.size < FETCH_LIMIT) break;
      cursor = newest.id;
    }
    return created;
  } finally {
    runningChannels.delete(channel.id);
  }
}

async function extractPage(channel: TextBasedChannel, guildId: string, messages: Message[]): Promise<number> {
  const newest = messages[messages.length - 1];
  const attachmentBudget = createTextAttachmentBudget();
  const attachmentText = await readTextAttachments(messages, attachmentBudget);
  const expandedMessages = messages.map((message) => {
    const window = toWindowMessage(message);
    const text = attachmentText.get(message.id);
    return text ? { ...window, content: `${window.content}\n${text}`.trim() } : window;
  });
  await runOnHourlyCheck({ channelId: channel.id, guildId, newMessages: messages });

  cacheMessages(
    expandedMessages.map((message) => ({
      messageId: message.id,
      channelId: channel.id,
      guildId,
      authorId: message.authorId,
      authorUsername: message.authorUsername,
      content: message.content,
      messageCreatedAt: message.createdAt,
    })),
  );

  // A picture is often the whole point of the message it was posted in, and
  // without it the extraction reads those messages as empty and remembers
  // nothing about them. Whatever does not fit the budget is marked in the
  // transcript rather than dropped silently.
  const settings = getSettings();
  const { images, unseen } = await imagePartsFor(messages, settings.visionEnabled ? settings.maxImages : 0);

  const windowMessages = markUnseenImages(expandedMessages, unseen);

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
    aiTask: 'factExtraction',
    schema: extractionSchema,
    hint: (answer) => answer.facts.map((fact) => fact.text).join(' '),
    systemInstruction: buildFactExtractionInstruction(),
    task: 'Extract the facts worth remembering from this channel.',
    material: {
      channelId: channel.id,
      // Which picture came from which message, in the order they are attached.
      ...(images.length > 0
        ? { images: images.map((image, index) => ({ index: index + 1, messageId: image.messageId })) }
        : {}),
      ...(background ? { pluginNotes: [background] } : {}),
    },
    windowMessages,
    anchorMessage: newest,
    guildId,
    images,
    attachmentBudget,
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

  return created.length;
}
