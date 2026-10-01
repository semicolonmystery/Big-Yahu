import type { Message, TextBasedChannel } from 'discord.js';
import type { BeforeReplyContext, BeforeReplyResult } from '@big-yahu/plugin-sdk';
import { withDefaults } from './config';
import { pollState, type PollState } from './pollState';
import { reactionLabel } from './support';

/** One reaction as the model reads it. */
interface MaterialReaction {
  /** The character, or `name:id` for a custom emoji — the same form add_reaction takes. */
  emoji: string;
  count: number;
  /** One of them is the bot's own. */
  mine?: true;
}

/** What one message in the window gains, where there is anything to gain. */
interface MessageState {
  reactions?: MaterialReaction[];
  poll?: PollState;
}

/**
 * What Discord returned alongside the messages the reply is being written
 * against: reactions, and the standing of any poll.
 *
 * Attached to each message in `material.messages` rather than gathered into a
 * block of their own keyed by message id, because the keyed block would repeat a
 * nineteen-digit id for every message that has one, and the messages are already
 * there with their ids. It also reads the way it should: a reaction and a poll
 * are part of the message they are on, not separate lists the model has to join.
 *
 * **One REST fetch of the channel's recent messages, once per reply**, whatever
 * the window holds and whichever of the two switches are on. Both
 * `message.reactions.cache` and `message.poll` are populated from that fetch's
 * own payload — Discord returns a message's reactions and its poll, counts
 * included, with the message — so nothing here costs a call per message, and no
 * gateway events are involved. Switching the poll state on adds no Discord call
 * at all; it reads more out of the payload already in hand.
 */
export async function withMessageState(ctx: BeforeReplyContext): Promise<BeforeReplyResult | void> {
  const config = withDefaults(ctx.getConfig());
  const wantReactions = config.enableReactionSummary;
  const wantPolls = config.enablePollSummary;
  // Both switched off, or the window set to nothing: no fetch at all. A disabled
  // feature has to cost nothing, or an operator cannot switch it off to find out
  // what it was costing.
  if ((!wantReactions && !wantPolls) || config.reactionSummaryMessages <= 0) return;

  const channel: TextBasedChannel = ctx.taggedMessage.channel;
  if (!('messages' in channel)) return;

  // Caught here rather than left to the engine: a channel where the bot cannot
  // read history would otherwise log a stack trace on every single reply, and
  // not knowing what people reacted with is not a reason to spoil the reply.
  const recent = await channel.messages.fetch({ limit: config.reactionSummaryMessages })
    .catch((error: unknown) => {
      console.warn('[extended-messages] could not read reactions in this channel:', error);
      return null;
    });
  if (!recent) return;

  const byMessage = new Map<string, MessageState>();
  for (const message of recent.values()) {
    const state: MessageState = {
      ...(wantReactions ? reactionsOf(message) : {}),
      ...(wantPolls ? pollOf(message) : {}),
    };
    if (Object.keys(state).length > 0) byMessage.set(message.id, state);
  }
  // Nobody has reacted to anything recently and there is no poll about, which is
  // the usual case. The draft goes back untouched rather than gaining an empty
  // field on every reply.
  if (byMessage.size === 0) return;

  const material = { ...ctx.draftPrompt.material };
  let attached = 0;
  for (const key of ['messages', 'quoted'] as const) {
    const listed = material[key];
    if (!Array.isArray(listed)) continue;
    material[key] = listed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return entry;
      const line = entry as Record<string, unknown>;
      const state = typeof line.id === 'string' ? byMessage.get(line.id) : undefined;
      if (!state) return entry;
      attached += 1;
      return { ...line, ...state };
    });
  }
  if (attached === 0) return;

  return { draftPrompt: { ...ctx.draftPrompt, material } };
}

function reactionsOf(message: Message): { reactions?: MaterialReaction[] } {
  const cached = message.reactions?.cache;
  if (!cached || cached.size === 0) return {};
  const found: MaterialReaction[] = [];
  for (const reaction of cached.values()) {
    const emoji = reactionLabel(reaction);
    if (!emoji) continue;
    found.push({ emoji, count: reaction.count, ...(reaction.me ? { mine: true as const } : {}) });
  }
  return found.length > 0 ? { reactions: found } : {};
}

/** `Message#poll` is `Poll | null`: null on every message that is not a poll, which is nearly all of them. */
function pollOf(message: Message): { poll?: PollState } {
  const poll = message.poll;
  if (!poll) return {};
  return { poll: pollState(poll) };
}
