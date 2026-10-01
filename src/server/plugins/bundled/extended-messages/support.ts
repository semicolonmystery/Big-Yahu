import {
  PermissionFlagsBits,
  type Guild,
  type GuildTextBasedChannel,
  type MessageReaction,
  type PermissionsString,
} from 'discord.js';
import type { PluginTool, PluginToolContext } from '@big-yahu/plugin-sdk';
import { withDefaults, type ExtendedMessagesFeature } from './config';

const MAX_SNOWFLAKE = (1n << 64n) - 1n;

/**
 * One refusal shape for everything here.
 *
 * `ok: false` is what the host's `rejected` check reads (`replyGeneration.ts`),
 * so a refused call never reads as a success and the model never finishes a turn
 * announcing a poll it did not post. That check did not always cover `ok`, and
 * this shape carried a duplicate `error` holding the same words to compensate;
 * the host was fixed instead, because every plugin reaches for `ok: false` first
 * and each one should not have to know that.
 */
export interface Refusal {
  ok: false;
  reason: string;
  discordCode?: string | number;
}

export function refuse(reason: string): Refusal {
  return { ok: false, reason };
}

export function safeError(error: unknown): Refusal {
  const candidate = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const code = typeof candidate.code === 'string' || typeof candidate.code === 'number' ? candidate.code : undefined;
  const message = error instanceof Error ? error.message : 'Discord rejected the operation.';
  return { ...refuse(message.slice(0, 300)), ...(code === undefined ? {} : { discordCode: code }) };
}

/**
 * A snowflake is the milliseconds since Discord's 2015 epoch shifted left 22
 * bits, so anything created after January 2015 is at least 17 digits. Rejecting
 * shorter ones here turns a model that invented a number into a clear error
 * rather than a request Discord refuses for reasons the model then guesses at.
 */
export function snowflake(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) {
    throw new Error(`${label} must be a Discord id.`);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > MAX_SNOWFLAKE) throw new Error(`${label} must be a Discord id.`);
  return value;
}

export function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const text = value.trim();
  if (!text) return undefined;
  if ([...text].length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters; that one is ${[...text].length}.`);
  }
  return text;
}

export function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return optionalText(value, label, maxLength)!;
}

export function booleanValue(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/** Only an https URL, since that is all Discord renders in an embed. */
export function httpsUrl(value: unknown, label: string): string | undefined {
  const text = optionalText(value, label, 2048);
  if (text === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} must be a full URL starting with https://.`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must start with https://.`);
  return parsed.toString();
}

/**
 * What the bot is allowed to ping on anything it sends from here, matching the
 * core's own `ALLOWED_MENTIONS` in `bot/replyPipeline.ts`.
 *
 * `parse: ['users']` is the hard stop: `@everyone`, `@here` and a role mention
 * cannot ping whatever ends up in a poll question or an embed description. A
 * poll answer or an embed field is text the model wrote from what people said,
 * so "put @everyone in the poll" must not be a server-wide ping.
 */
export const ALLOWED_MENTIONS = { parse: ['users'] } as const;

/** Only ever the guild which produced this tool invocation. Model arguments cannot select another one. */
export function invocationGuild(ctx: PluginToolContext): Guild {
  if (!ctx.discordClient) throw new Error('The Discord bot is offline.');
  const guild = ctx.discordClient.guilds.cache.get(ctx.invocation.guildId);
  if (!guild) throw new Error('The Discord server for this request is no longer available.');
  return guild;
}

/**
 * Only ever the channel the request arrived in. There is deliberately no channel
 * argument: a model that could name one could be talked into posting a poll
 * somewhere nobody asked for one.
 */
export function invocationChannel(ctx: PluginToolContext): GuildTextBasedChannel {
  const guild = invocationGuild(ctx);
  const channel = guild.channels.cache.get(ctx.invocation.channelId);
  if (!channel || !channel.isTextBased()) throw new Error('This channel is not one I can post in.');
  return channel;
}

/**
 * The bot's own permissions in this channel, checked before acting rather than
 * after Discord refuses — the same pattern as `bot/channelAccess.ts`. Overwrites
 * mean a guild-wide permission says nothing about one channel.
 */
export function requireBotPermissions(
  ctx: PluginToolContext,
  channel: GuildTextBasedChannel,
  needed: Array<{ name: PermissionsString; label: string }>,
): void {
  const me = ctx.discordClient?.user;
  if (!me) throw new Error('The Discord bot is offline.');
  const permissions = channel.permissionsFor(me);
  const missing = needed.filter(({ name }) => !permissions?.has(PermissionFlagsBits[name]));
  if (missing.length > 0) {
    throw new Error(`Discord will not let me do that here — I am missing ${missing.map((entry) => entry.label).join(', ')}.`);
  }
}

/**
 * `<:name:id>` and `<a:name:id>` are what Discord writes in message text;
 * `name:id` and `a:name:id` are what it writes in a reaction and what this
 * plugin reports back. All four are accepted, so whichever form the model copied
 * works.
 */
const WRAPPED_EMOJI = /^<a?:([A-Za-z0-9_]{2,32}):(\d{17,20})>$/;
const BARE_EMOJI = /^(?:a:)?([A-Za-z0-9_]{2,32}):(\d{17,20})$/;

export interface ResolvedEmoji {
  /** What discord.js is handed: `name:id` for a custom emoji, the character itself otherwise. */
  resolvable: string;
  /** How it is named back to the model, in the same form the reaction list uses. */
  label: string;
}

/**
 * A unicode emoji, or one of *this guild's* custom emoji.
 *
 * The guild check is the point. A custom emoji id from another server is a
 * perfectly well-formed id that Discord rejects with an unknown-emoji error, and
 * the model reading that back guesses at what it did wrong and tries another id.
 * Saying "this server does not have that one" ends it.
 */
export function resolveEmoji(value: unknown, label: string, guild: Guild): ResolvedEmoji {
  const text = requiredText(value, label, 64);
  const custom = WRAPPED_EMOJI.exec(text) ?? BARE_EMOJI.exec(text);
  const id = custom ? custom[2] : (/^\d{17,20}$/.test(text) ? text : null);
  if (id) {
    const emoji = guild.emojis.cache.get(id);
    if (!emoji) throw new Error(`This server does not have a custom emoji with id ${id}.`);
    return { resolvable: `${emoji.name}:${emoji.id}`, label: `${emoji.name}:${emoji.id}` };
  }
  if (text.includes(':')) {
    throw new Error(`${label} looks like a custom emoji but has no id. Use name:id, taking both from a reaction you can see.`);
  }
  // Anything spellable in plain ASCII is a name, not an emoji. A keycap such as
  // 1️⃣ survives this: the digit is followed by a variation selector, so the
  // whole string is not ASCII.
  if (/^[\w\s-]+$/.test(text)) {
    throw new Error(`${label} must be the emoji character itself, not its name.`);
  }
  return { resolvable: text, label: text };
}

/** How a reaction is named everywhere here: the character, or `name:id` for a custom one. */
export function reactionLabel(reaction: MessageReaction): string | null {
  const { id, name } = reaction.emoji;
  if (id) return `${name ?? 'emoji'}:${id}`;
  return name ?? null;
}

/**
 * How many of these tools one reply has already fired.
 *
 * Keyed by the message that started the turn, which is host-authenticated, so
 * the model cannot reset its own budget by claiming a different one. Bounded
 * because nothing clears it: a reply either finishes or it does not, and there
 * is no hook that would tell this module which.
 */
const FIRED = new Map<string, number>();
const TRACKED_INVOCATIONS = 500;

export function actionSlot(ctx: PluginToolContext): Refusal | null {
  const { maxActionsPerReply } = withDefaults(ctx.getConfig());
  const key = ctx.invocation.messageId;
  const used = FIRED.get(key) ?? 0;
  if (used >= maxActionsPerReply) {
    return refuse(`That is already ${used} of these in one reply, which is the limit. Say what you meant to say instead.`);
  }
  FIRED.set(key, used + 1);
  // Map iteration is insertion-ordered, so the first key is the oldest turn.
  while (FIRED.size > TRACKED_INVOCATIONS) {
    const oldest = FIRED.keys().next();
    if (oldest.done) break;
    FIRED.delete(oldest.value);
  }
  return null;
}

/** Test seam: the per-reply counters are module state with no lifecycle to hang a reset on. */
export function resetActionSlots(): void {
  FIRED.clear();
}

/**
 * The switch check and the error wrapping every tool here shares. A handler may
 * throw freely: what reaches the model is always JSON saying what went wrong.
 */
export function guarded(
  feature: ExtendedMessagesFeature,
  operation: PluginTool['handler'],
): PluginTool['handler'] {
  return async (args, ctx) => {
    if (!withDefaults(ctx.getConfig())[feature]) {
      return refuse('That Extended Messages capability is switched off in the plugin settings.');
    }
    try {
      return await operation(args, ctx);
    } catch (error) {
      return safeError(error);
    }
  };
}
