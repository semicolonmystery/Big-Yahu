import type { PluginTool } from '@big-yahu/plugin-sdk';
import { pollState } from './pollState';
import {
  actionSlot,
  guarded,
  invocationChannel,
  optionalText,
  refuse,
  requireBotPermissions,
  snowflake,
} from './support';

export const endPollTool: PluginTool = {
  enabledByConfig: 'enableEndPoll',
  // The poll is closed the moment this returns; nothing about ending it needs a
  // second round trip to the model.
  effect: true,
  name: 'end_poll',
  description:
    'Close a poll right now, before its own timer would. Only works on a poll this bot posted — Discord refuses '
    + 'anything else outright. Final: once a poll is ended nobody can vote again and nobody, including you, can '
    + 'reopen it. For a poll that has done its job or should never have gone out the way it did, not for one that '
    + 'is simply still running.',
  parameters: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'The message carrying the poll, as digits only. It has to be one in this channel, and one this bot posted.',
      },
      why: { type: 'string', description: 'One short line, for the logs. Nobody in the chat sees it.' },
    },
    required: ['messageId'],
  },
  handler: guarded('enableEndPoll', async (args, ctx) => {
    const messageId = snowflake(args.messageId, 'messageId');
    const why = optionalText(args.why, 'why', 300);

    // The channel is the invocation's, never an argument, exactly as the other
    // message-id tools here have it.
    const channel = invocationChannel(ctx);
    requireBotPermissions(ctx, channel, [{ name: 'ReadMessageHistory', label: 'Read Message History' }]);

    const slot = actionSlot(ctx);
    if (slot) return slot;

    // Forced: ending a poll off a stale cached copy risks reading it as still
    // open when it has already closed in the meantime.
    const message = await channel.messages.fetch({ message: messageId, force: true });
    const poll = message.poll;
    if (!poll) return refuse('That message does not carry a poll.');

    // Discord itself only lets the poll's own author end it, and refuses anyone
    // else's attempt with a 403 — checked here so that reads as a plain answer
    // rather than a Discord error the model has to interpret.
    const botId = ctx.discordClient?.user?.id;
    if (!botId || message.author?.id !== botId) {
      return refuse('I did not post that poll, so Discord will not let me end it.');
    }

    if (pollState(poll).closed) return refuse('That poll has already ended.');

    if (why) console.log(`[extended-messages] ending poll ${messageId}: ${why}`);

    const ended = await channel.messages.endPoll(messageId);
    // `endPoll` hands back the message Discord just finalised; reused rather
    // than the pre-fetch poll so the standing reported is the final one, not
    // the tally from a moment before it closed.
    const finalState = ended.poll ? pollState(ended.poll) : pollState(poll);

    return { ok: true, ended: true, messageId, ...finalState };
  }),
};
