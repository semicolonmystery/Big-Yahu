import type { Message } from 'discord.js';
import { markHostFailures, runEscalatableExtraction, windowMessagesWithAttachments } from './context';
import type { TextAttachmentBudget } from '../bot/textAttachments';
import type { WindowMessage } from './context';
import { topicSchema } from './schemas';
import type { TopicResult } from './schemas';
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
    schema: topicSchema,
    hint: (result) => result.searchQuery,
    systemInstruction: buildTopicExtractionInstruction(),
    task: 'Work out what is being asked.',
    material: { channelId: taggedMessage.channelId, taggingMessageId: taggedMessage.id },
    windowMessages,
    anchorMessage: taggedMessage,
    guildId,
    attachmentBudget,
  });

  return { topic, windowMessages, discordMessages };
}
