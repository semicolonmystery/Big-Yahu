import type { Message } from 'discord.js';
import { markHostFailures, runEscalatableExtraction, windowMessagesWithAttachments } from './context';
import type { TextAttachmentBudget } from '../bot/textAttachments';
import type { WindowMessage } from './context';
import { MAX_TOPIC_SEARCHES, topicSchemaFor } from './schemas';
import type { TopicResult } from './schemas';
import { factTypeIds, knownTypes } from '../db/repositories/factTypesRepo';
import { buildTopicExtractionInstruction } from './prompts/build';

/**
 * Reads the conversation leading up to a mention and works out what is being
 * discussed, so the right memories can be retrieved before replying.
 */
export async function extractTopic(
  taggedMessage: Message,
  guildId: string,
  contextSize: number,
  attachmentBudget?: TextAttachmentBudget,
): Promise<{ topic: TopicResult; windowMessages: WindowMessage[]; discordMessages: Message[] }> {
  const preceding = await taggedMessage.channel.messages.fetch({
    before: taggedMessage.id,
    limit: contextSize,
  });

  // Kept alongside the flattened form: pictures live on the Discord message and
  // there is no way back to it from a WindowMessage.
  const discordMessages = [...preceding.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .concat(taggedMessage);

  // The bot's own outage notices stay in place, as what they actually were.
  const windowMessages = markHostFailures(await windowMessagesWithAttachments(discordMessages, attachmentBudget));

  const topic = await runEscalatableExtraction<TopicResult>({
    aiTask: 'topicExtraction',
    schema: topicSchemaFor(factTypeIds()),
    hint: (result) => result.searches.map((search) => search.query).join(' '),
    systemInstruction: buildTopicExtractionInstruction(),
    task: 'Work out what is being asked.',
    material: { channelId: taggedMessage.channelId, taggingMessageId: taggedMessage.id },
    windowMessages,
    anchorMessage: taggedMessage,
    guildId,
    attachmentBudget,
  });

  // The schema requires `searches`, and a missing one would still only mean the
  // reply searches on the topic itself — not worth failing a reply over.
  const asked = Array.isArray(topic.searches) ? topic.searches : [];
  // The cap is enforced here rather than in the schema, which has no maxItems:
  // one topic call must not be able to fan out into arbitrary cost.
  if (asked.length > MAX_TOPIC_SEARCHES) {
    console.warn(`[ai] topicExtraction asked for ${asked.length} searches; keeping the first ${MAX_TOPIC_SEARCHES}`);
  }
  // A type nobody defined would filter the search down to nothing, which is
  // worse than searching everything.
  topic.searches = asked.slice(0, MAX_TOPIC_SEARCHES)
    .map((search) => ({ ...search, type: knownTypes([search.type])[0] ?? '' }));

  return { topic, windowMessages, discordMessages };
}
