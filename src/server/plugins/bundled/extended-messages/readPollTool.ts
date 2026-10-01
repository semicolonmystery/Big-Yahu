import type { PluginTool } from '@big-yahu/plugin-sdk';
import { withDefaults } from './config';
import { answerState, pollState, type PollAnswerState } from './pollState';
import {
  actionSlot,
  guarded,
  invocationChannel,
  refuse,
  requireBotPermissions,
  snowflake,
} from './support';

/** One answer, plus who voted for it where that was asked for and affordable. */
interface ReadPollAnswer extends PollAnswerState {
  people?: Array<{ id: string; name?: string }>;
  /** Votes beyond the people named, so a capped list is never read as the whole of it. */
  andOthers?: number;
  /** The per-lookup answer cap stopped this one being resolved at all. */
  votersNotLookedUp?: true;
}

export const readPollTool: PluginTool = {
  enabledByConfig: 'enableReadPoll',
  // Deliberately not an effect tool: the standing of the poll is the answer, and
  // the reply is being written to say it.
  name: 'read_poll',
  description:
    'Read a Discord poll back: the question, each answer with its vote count, whether voting is still open, and '
    + 'who voted for what. For a poll older than the messages you were given, or when which people voted is the '
    + 'question — a poll on a recent message already has its counts attached to it, so asking again for the same '
    + 'number is a wasted call. While a poll is still running the counts are the tally so far and Discord does not '
    + 'promise they are exact; only a poll whose voteCountsFinal is true has a result. Resolving voters costs a '
    + 'Discord call per answer and is capped.',
  parameters: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'The message carrying the poll, as digits only. It has to be one in this channel.',
      },
    },
    required: ['messageId'],
  },
  handler: guarded('enableReadPoll', async (args, ctx) => {
    const messageId = snowflake(args.messageId, 'messageId');
    const config = withDefaults(ctx.getConfig());

    // The channel is the invocation's, never an argument, exactly as who_reacted
    // has it: a poll in a channel nobody asked about is not the bot's to read.
    const channel = invocationChannel(ctx);
    requireBotPermissions(ctx, channel, [{ name: 'ReadMessageHistory', label: 'Read Message History' }]);

    const slot = actionSlot(ctx);
    if (slot) return slot;

    // Forced: an unforced fetch hands back whatever is in the message cache, and
    // a cached copy's vote counts are as old as the copy.
    const message = await channel.messages.fetch({ message: messageId, force: true });
    const poll = message.poll;
    // Said rather than thrown: a message with no poll on it is an ordinary wrong
    // guess by the model, not a failure, and it should read as one.
    if (!poll) return refuse('That message does not carry a poll.');

    const state = pollState(poll);
    const all = [...poll.answers.values()];
    const answers: ReadPollAnswer[] = [];
    for (const [index, answer] of all.entries()) {
      const base = answerState(answer);
      // Counts come off the message that was already fetched, so every answer is
      // listed whatever the caps say; only the voters cost a call each.
      if (!config.enablePollVoters) {
        answers.push(base);
        continue;
      }
      if (index >= config.readPollMaxAnswers) {
        answers.push({ ...base, votersNotLookedUp: true as const });
        continue;
      }
      // `PollAnswer#fetchVoters` is deprecated in discord.js 14.27 and only
      // forwards to this, emitting a process warning on the way.
      const voters = await answer.voters.fetch({ limit: config.readPollMaxVoters });
      const ids = [...voters.values()].filter((user) => !user.bot).map((user) => user.id);
      // Both the id and the name, as who_reacted has it: the id is what a real
      // ping is written from, but the reply sanitiser only keeps a mention for
      // somebody the prompt already named, and a silent voter is not one of
      // those — so the name is there to be said when the mention cannot survive.
      const names = ctx.resolveUserNames(ids);
      answers.push({
        ...base,
        people: ids.map((id) => (names[id] ? { id, name: names[id] } : { id })),
        ...(base.votes > voters.size ? { andOthers: base.votes - voters.size } : {}),
      });
    }

    // `answers` last on purpose: it replaces the plain list `pollState` built
    // with the same answers plus their voters, so the shape stays the one the
    // material uses and only gains a field.
    return { ok: true, messageId, ...state, answers };
  }),
};
