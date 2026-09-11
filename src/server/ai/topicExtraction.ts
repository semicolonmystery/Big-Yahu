import type { Message } from 'discord.js';
import { runEscalatableExtraction, windowMessagesWithAttachments } from './context';
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

  const windowMessages = await windowMessagesWithAttachments(discordMessages, attachmentBudget);

  const topic = await runEscalatableExtraction<TopicResult>({
    schema: topicSchema,
    systemInstruction: buildTopicExtractionInstruction(),
    task: `The last message (id=${taggedMessage.id}) is the one that mentioned the bot. Work out what is being asked.`,
    windowMessages,
    anchorMessage: taggedMessage,
    guildId,
    attachmentBudget,
  });

  return { topic, windowMessages, discordMessages };
}
