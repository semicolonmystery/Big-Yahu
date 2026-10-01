import type { PluginTool } from '@big-yahu/plugin-sdk';
import { withDefaults } from './config';
import {
  actionSlot,
  guarded,
  invocationChannel,
  invocationGuild,
  reactionLabel,
  requireBotPermissions,
  resolveEmoji,
  snowflake,
} from './support';

export const addReactionTool: PluginTool = {
  enabledByConfig: 'enableReactions',
  // The reaction is on the message once this returns, and a reaction is often the
  // whole answer. Waiting to be told it worked only invites a message saying
  // "reacted 👍", which is the one thing a reaction exists to avoid.
  effect: true,
  name: 'add_reaction',
  description:
    'Put a reaction on a message in this channel. Cheap, and often the better answer: agreeing, finding '
    + 'something funny, acknowledging being told something. Use it on its own where a message would be noise, '
    + 'or alongside a reply when both fit. The emoji is the character itself, or name:id for one of this '
    + 'server\'s custom emoji — take name:id from a reaction already on a message.',
  parameters: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'Which message to react to, as digits only. It has to be one in this channel.',
      },
      emoji: {
        type: 'string',
        description: 'The emoji character, or name:id for one of this server\'s custom emoji.',
      },
    },
    required: ['messageId', 'emoji'],
  },
  handler: guarded('enableReactions', async (args, ctx) => {
    const messageId = snowflake(args.messageId, 'messageId');
    const guild = invocationGuild(ctx);
    const emoji = resolveEmoji(args.emoji, 'emoji', guild);

    // The channel is the invocation's, never an argument: a reaction on a message
    // in a channel nobody asked about is a thing the bot should not be able to do.
    const channel = invocationChannel(ctx);
    requireBotPermissions(ctx, channel, [
      { name: 'AddReactions', label: 'Add Reactions' },
      { name: 'ReadMessageHistory', label: 'Read Message History' },
    ]);

    const slot = actionSlot(ctx);
    if (slot) return slot;

    const message = await channel.messages.fetch(messageId);
    await message.react(emoji.resolvable);
    return { ok: true, messageId, emoji: emoji.label };
  }),
};

export const whoReactedTool: PluginTool = {
  enabledByConfig: 'enableWhoReacted',
  // Deliberately not an effect tool: the names are the answer, and the reply is
  // being written to say them.
  name: 'who_reacted',
  description:
    'Find out which people reacted to a message, and with what. Only when who reacted is actually the question — '
    + 'the reactions and their counts are already attached to the messages you were given, so this is for putting '
    + 'names to them. It costs a Discord call per reaction and is capped.',
  parameters: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'The message whose reactions to resolve, as digits only. It has to be one in this channel.',
      },
    },
    required: ['messageId'],
  },
  handler: guarded('enableWhoReacted', async (args, ctx) => {
    const messageId = snowflake(args.messageId, 'messageId');
    const config = withDefaults(ctx.getConfig());

    const channel = invocationChannel(ctx);
    requireBotPermissions(ctx, channel, [{ name: 'ReadMessageHistory', label: 'Read Message History' }]);

    const slot = actionSlot(ctx);
    if (slot) return slot;

    // Forced: an unforced fetch hands back whatever is in the message cache, and
    // a cached copy's reaction counts are as old as the copy.
    const message = await channel.messages.fetch({ message: messageId, force: true });
    const all = [...message.reactions.cache.values()];
    const resolving = all.slice(0, config.whoReactedMaxReactions);

    const reactions = [];
    for (const reaction of resolving) {
      const label = reactionLabel(reaction);
      if (!label) continue;
      const users = await reaction.users.fetch({ limit: config.whoReactedMaxUsers });
      const ids = [...users.values()].filter((user) => !user.bot).map((user) => user.id);
      // Both the id and the name. The id is what a real ping is written from, but
      // the reply sanitiser only keeps a mention for somebody the prompt already
      // named, and whoever reacted without speaking is not one of those — so the
      // name is there to be said when the mention cannot survive.
      const names = ctx.resolveUserNames(ids);
      reactions.push({
        emoji: label,
        count: reaction.count,
        people: ids.map((id) => (names[id] ? { id, name: names[id] } : { id })),
        // Said outright, so a capped list is never read as the whole of it.
        ...(reaction.count > users.size ? { andOthers: reaction.count - users.size } : {}),
      });
    }

    return {
      ok: true,
      messageId,
      reactions,
      ...(all.length > resolving.length ? { reactionsNotLookedUp: all.length - resolving.length } : {}),
    };
  }),
};
