import type { BigYahuPlugin, PluginField } from '@big-yahu/plugin-sdk';
import { DEFAULT_CONFIG, withDefaults } from './config';
import { pollTool } from './pollTool';
import { embedTool } from './embedTool';
import { addReactionTool, whoReactedTool } from './reactionTools';
import { withReactions } from './reactionSummary';

const plugin: BigYahuPlugin = {
  id: 'extended-messages',
  name: 'Extended Messages',
  description: 'Lets the bot see reactions, react itself, and send Discord polls and embeds.',
  version: '1.0.0',
  defaultConfig: { ...DEFAULT_CONFIG },

  instructions(ctx) {
    const config = withDefaults(ctx.getConfig());
    const lines: string[] = ['Besides writing a message, you can use the channel itself.'];

    if (config.enableReactionSummary && config.reactionSummaryMessages > 0) {
      lines.push(
        'A message in `messages` may carry `reactions`: what people have put on it, how many of each, and `mine` '
        + 'where one of them is yours. `emoji` is the character itself, or `name:id` for one of this server\'s custom '
        + 'emoji. These are not private notes from a plugin — a reaction is public, everybody in the channel can see '
        + 'it, and you may say what is there whenever it is relevant: that three people laughed at something, that '
        + 'nobody agreed, that you already reacted to it. Equally, do not read the list out for its own sake; it is '
        + 'there so you know what the room thought, the same way you know what it said.',
      );
    }

    if (config.enableReactions) {
      lines.push(
        'add_reaction puts a reaction on a message here. It is the cheapest thing you can do and often the better '
        + 'answer: agreeing, finding something funny, taking somebody\'s point. Where a whole message would be noise, '
        + 'react instead and say nothing. Where both fit, do both. Take `name:id` for a custom emoji from a reaction '
        + 'you can already see rather than guessing at an id.',
      );
    }

    if (config.enableWhoReacted) {
      lines.push(
        'who_reacted puts names to a message\'s reactions. Only reach for it when who reacted is the actual question — '
        + 'the counts are already in front of you, so asking again to learn the same number is a wasted call. It is '
        + 'capped, so a long list comes back short and says so.',
      );
    }

    if (config.enablePolls) {
      lines.push(
        'send_poll posts a real Discord poll: a question and 2 to 10 options people click. For a genuine question to '
        + 'the channel where what people pick is the answer — what to play, when to start, which of two things. Not '
        + 'decoration, not a rhetorical question, and never when asking in your own words would do. One poll settles '
        + 'something; a poll on every topic is noise.',
      );
    }

    if (config.enableEmbeds) {
      lines.push(
        'send_embed posts a boxed, laid-out block: a title, a body, and labelled fields. For something structured that '
        + 'genuinely benefits from being laid out — a comparison, a set of rules somebody asked for, results with '
        + 'several parts. An embed around two sentences of chat looks like a press release and makes you the one '
        + 'thing you are not supposed to be. Ordinary answers are messages.',
      );
    }

    if (config.enablePolls || config.enableEmbeds || config.enableReactions) {
      lines.push(
        'For all of these: write your reply as well. They go out beside what you say, not instead of it, and once one '
        + 'is sent there is nothing to announce — do not follow a poll with a message explaining that you have posted '
        + `a poll. At most ${config.maxActionsPerReply} of them in one reply; past that you are decorating rather than `
        + 'answering. If one comes back refused, it did not happen, and you say so rather than pretending it did.',
      );
    }

    return lines.join('\n\n');
  },

  tools: [pollTool, embedTool, addReactionTool, whoReactedTool],

  /**
   * The reaction list goes in through beforeReply rather than annotateContext.
   * Everything annotateContext contributes is wrapped in "never read it out,
   * quote it, or tell anyone what it says", which is right for a private score
   * and exactly wrong here: a reaction is public, and the whole point is that
   * the bot can say three people laughed at that.
   */
  beforeReply: withReactions,

  configSchema: [
    {
      name: 'enableReactionSummary',
      label: 'See reactions on messages',
      type: 'boolean',
      description:
        'Attach what people have reacted with, and how many, to the messages in every reply prompt. '
        + 'Costs one extra Discord call per reply, whatever the conversation holds.',
    },
    {
      name: 'reactionSummaryMessages',
      label: 'Reactions read off the last N messages',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
      description:
        'How far back that one call looks. Zero switches the call off without switching the feature off, '
        + 'which is how you measure what it was costing. Discord\'s own maximum is 100.',
    },
    {
      name: 'enableReactions',
      label: 'React to messages',
      type: 'boolean',
      description:
        'Let the bot put a reaction on a message in the channel it is replying in, with a unicode emoji or one '
        + 'of the server\'s own. It needs the Add Reactions permission there.',
    },
    {
      name: 'enableWhoReacted',
      label: 'Look up who reacted',
      type: 'boolean',
      description:
        'Let the bot resolve which people reacted with what. The only thing here that costs a Discord call per '
        + 'reaction, so it is capped by the two settings below.',
    },
    {
      name: 'whoReactedMaxReactions',
      label: 'Reactions resolved per lookup',
      type: 'number',
      min: 1,
      max: 20,
      step: 1,
      description: 'How many different emoji on one message get looked up. Anything past this is reported as not looked up.',
    },
    {
      name: 'whoReactedMaxUsers',
      label: 'People named per reaction',
      type: 'number',
      min: 1,
      max: 100,
      step: 1,
      description: 'How many people one reaction names. A longer list comes back short and says how many are missing.',
    },
    {
      name: 'enablePolls',
      label: 'Send polls',
      type: 'boolean',
      description: 'Let the bot post a native Discord poll with 2 to 10 answers. It needs Send Messages in the channel.',
    },
    {
      name: 'enableEmbeds',
      label: 'Send embeds',
      type: 'boolean',
      description:
        'Let the bot post an embed: a boxed block with a title, body and labelled fields. It needs Embed Links '
        + 'as well as Send Messages, or Discord accepts the message and silently drops the embed.',
    },
    {
      name: 'maxActionsPerReply',
      label: 'Polls, embeds, reactions and lookups per reply',
      type: 'number',
      min: 1,
      max: 10,
      step: 1,
      description:
        'The total any one reply may fire, across all four tools. Two is a poll or an embed plus a reaction; much '
        + 'more than that and a single mention turns into a page of boxes.',
    },
  ] satisfies PluginField[],
};

export default plugin;
