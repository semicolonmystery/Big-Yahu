import type { PollData } from 'discord.js';
import type { PluginTool } from '@big-yahu/plugin-sdk';
import {
  ALLOWED_MENTIONS,
  actionSlot,
  booleanValue,
  guarded,
  integer,
  invocationChannel,
  invocationGuild,
  requiredText,
  resolveEmoji,
  requireBotPermissions,
} from './support';

/** Discord's own limits on a poll. Breaking one is a refusal, not something to quietly trim. */
const QUESTION_LIMIT = 300;
const ANSWER_LIMIT = 55;
const MIN_ANSWERS = 2;
const MAX_ANSWERS = 10;
/** Hours. Discord's maximum is 32 days. */
const MAX_DURATION_HOURS = 24 * 32;

export const pollTool: PluginTool = {
  enabledByConfig: 'enablePolls',
  // Nothing comes back worth waiting for: the poll is in the channel and the
  // votes arrive over the next hours, not in this reply.
  effect: true,
  name: 'send_poll',
  description:
    'Post a real Discord poll in this channel, with a question and 2 to 10 answers people click. '
    + 'For an actual question to the channel where the answer is which option people pick. Not for a rhetorical '
    + 'question, not as decoration, and not when you could simply ask in your reply. Write your reply as well — '
    + 'the poll goes out beside it, not instead of it.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: `What is being asked, at most ${QUESTION_LIMIT} characters. One question, no preamble.`,
      },
      answers: {
        type: 'array',
        minItems: MIN_ANSWERS,
        maxItems: MAX_ANSWERS,
        description: `The options, ${MIN_ANSWERS} to ${MAX_ANSWERS} of them. Fewer or more is refused.`,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: `The option, at most ${ANSWER_LIMIT} characters.` },
            emoji: {
              type: 'string',
              description:
                'Optional emoji shown beside it: the character itself, or name:id for one of this server\'s '
                + 'custom emoji. A custom emoji this server does not have is refused.',
            },
          },
          required: ['text'],
        },
      },
      durationHours: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_DURATION_HOURS,
        description: `How long voting stays open, in whole hours, 1 to ${MAX_DURATION_HOURS}. A day is usually right.`,
      },
      allowMultiple: {
        type: 'boolean',
        description: 'True lets each person pick several answers. Defaults to false, one pick each.',
      },
    },
    required: ['question', 'answers', 'durationHours'],
  },
  handler: guarded('enablePolls', async (args, ctx) => {
    const question = requiredText(args.question, 'question', QUESTION_LIMIT);
    if (!Array.isArray(args.answers)) throw new Error('answers must be a list of options.');
    // Said plainly rather than padded out to two or trimmed down to ten: a poll
    // with an option the bot invented, or with the model's last option missing,
    // is a worse answer than no poll and nobody can tell it happened.
    if (args.answers.length < MIN_ANSWERS) {
      throw new Error(`A poll needs at least ${MIN_ANSWERS} answers; that one has ${args.answers.length}.`);
    }
    if (args.answers.length > MAX_ANSWERS) {
      throw new Error(`Discord allows at most ${MAX_ANSWERS} answers; that one has ${args.answers.length}.`);
    }

    const guild = invocationGuild(ctx);
    const answers = args.answers.map((entry, index) => {
      const option = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {};
      const emoji = option.emoji === undefined || option.emoji === null
        ? undefined
        : resolveEmoji(option.emoji, `answers[${index}].emoji`, guild);
      return {
        text: requiredText(option.text, `answers[${index}].text`, ANSWER_LIMIT),
        ...(emoji ? { emoji: emoji.resolvable } : {}),
      };
    });
    const seen = new Set<string>();
    for (const answer of answers) {
      const key = answer.text.toLowerCase();
      if (seen.has(key)) throw new Error(`Two answers both say "${answer.text}". Give each option its own text.`);
      seen.add(key);
    }

    const duration = integer(args.durationHours, 'durationHours', 1, MAX_DURATION_HOURS);
    const allowMultiselect = booleanValue(args.allowMultiple, 'allowMultiple', false);

    const channel = invocationChannel(ctx);
    requireBotPermissions(ctx, channel, [{ name: 'SendMessages', label: 'Send Messages' }]);

    const slot = actionSlot(ctx);
    if (slot) return slot;

    // The shape discord.js turns into Discord's payload: `question.text`,
    // `answers[].poll_media`, `duration` in hours, `allow_multiselect`.
    const poll: PollData = { question: { text: question }, answers, duration, allowMultiselect };
    const sent = await channel.send({ poll, allowedMentions: ALLOWED_MENTIONS });

    return {
      ok: true,
      messageId: sent.id,
      question,
      answers: answers.map((answer) => answer.text),
      durationHours: duration,
      allowMultiple: allowMultiselect,
    };
  }),
};
