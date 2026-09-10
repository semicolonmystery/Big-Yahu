import { Events, type Client, type Message } from 'discord.js';
import { isServedGuild } from '../../env';
import { ensureChannel } from '../../db/repositories/checkpointRepo';
import { canExtractFrom, canReplyIn } from '../../db/repositories/channelSettingsRepo';
import { runOnBotTagged, runOnMessage } from '../../plugins/engine';
import { handleMention } from '../replyPipeline';

let draining = false;
const active = new Set<Promise<void>>();

export async function drainMessageHandlers(): Promise<void> {
  draining = true;
  await Promise.allSettled([...active]);
}

export function registerMessageCreate(client: Client): void {
  draining = false;
  client.on(Events.MessageCreate, (message: Message) => {
    if (draining) return;
    const work = handleMessage(client, message).catch((error: unknown) => {
      console.error('[bot] message handling failed:', error);
    });
    active.add(work);
    void work.finally(() => active.delete(work));
  });
}

/** A direct @mention, or a reply to one of the bot's own messages — @everyone does not count. */
function isAddressedToBot(message: Message, botId: string): boolean {
  if (message.mentions.users.has(botId)) return true;
  return message.reference !== null && message.mentions.repliedUser?.id === botId;
}

async function handleMessage(client: Client, message: Message): Promise<void> {
  if (message.author.bot || !message.guildId) return;

  // Before anything else, so a message from another guild costs nothing. Lets
  // several instances share one bot account, each serving a single guild.
  if (!isServedGuild(message.guildId)) return;

  // Channels enter the hourly rotation the first time anything is said in them —
  // but only those the admin has left readable.
  if (canExtractFrom(message.channelId)) {
    ensureChannel(message.channelId, message.guildId);
  }

  // A channel the bot may not write in is ignored outright, plugins included,
  // so nothing can post there by another route.
  if (!canReplyIn(message.channelId)) return;

  await runOnMessage({ message });

  if (!client.user || !isAddressedToBot(message, client.user.id)) return;

  await runOnBotTagged({ message });

  try {
    await handleMention(message);
  } catch (error) {
    console.error('[bot] reply pipeline failed:', error);
  }
}
