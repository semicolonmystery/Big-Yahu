import type { Message, TextBasedChannel } from 'discord.js';
import type { BeforeReplyContext, BeforeReplyResult } from '@big-yahu/plugin-sdk';
import { withDefaults } from './config';
import { reactionLabel } from './support';

/** One reaction as the model reads it. */
interface MaterialReaction {
  /** The character, or `name:id` for a custom emoji — the same form add_reaction takes. */
  emoji: string;
  count: number;
  /** One of them is the bot's own. */
  mine?: true;
}

/**
 * Reactions on the messages the reply is being written against.
 *
 * Attached to each message in `material.messages` rather than gathered into a
 * block of their own keyed by message id, because the keyed block would repeat a
 * nineteen-digit id for every message that has a reaction, and the messages are
 * already there with their ids. It also reads the way it should: a reaction is
 * part of the message it is on, not a separate list the model has to join.
 *
 * One REST fetch of the channel's recent messages, once per reply, whatever the
 * window holds. `message.reactions.cache` is populated from that fetch's own
 * payload — Discord returns a message's reactions with the message — so nothing
 * here costs a call per message, and no gateway reaction events are involved.
 */
export async function withReactions(ctx: BeforeReplyContext): Promise<BeforeReplyResult | void> {
  const config = withDefaults(ctx.getConfig());
  // Switched off, or the window set to nothing: no fetch at all. A disabled
  // feature has to cost nothing, or an operator cannot switch it off to find out
  // what it was costing.
  if (!config.enableReactionSummary || config.reactionSummaryMessages <= 0) return;

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

  const byMessage = new Map<string, MaterialReaction[]>();
  for (const message of recent.values()) {
    const found = summarise(message);
    if (found.length > 0) byMessage.set(message.id, found);
  }
  // Nobody has reacted to anything recently, which is the usual case. The draft
  // goes back untouched rather than gaining an empty field on every reply.
  if (byMessage.size === 0) return;

  const material = { ...ctx.draftPrompt.material };
  let attached = 0;
  for (const key of ['messages', 'quoted'] as const) {
    const listed = material[key];
    if (!Array.isArray(listed)) continue;
    material[key] = listed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return entry;
      const line = entry as Record<string, unknown>;
      const reactions = typeof line.id === 'string' ? byMessage.get(line.id) : undefined;
      if (!reactions) return entry;
      attached += 1;
      return { ...line, reactions };
    });
  }
  if (attached === 0) return;

  return { draftPrompt: { ...ctx.draftPrompt, material } };
}

function summarise(message: Message): MaterialReaction[] {
  const cached = message.reactions?.cache;
  if (!cached || cached.size === 0) return [];
  const found: MaterialReaction[] = [];
  for (const reaction of cached.values()) {
    const emoji = reactionLabel(reaction);
    if (!emoji) continue;
    found.push({ emoji, count: reaction.count, ...(reaction.me ? { mine: true as const } : {}) });
  }
  return found;
}
