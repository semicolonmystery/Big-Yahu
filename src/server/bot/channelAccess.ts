import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Client, Guild, GuildTextBasedChannel } from 'discord.js';
import { isServedGuild } from '../env';
import { canExtractFrom } from '../db/repositories/channelSettingsRepo';

/**
 * The one gate every cross-channel read goes through.
 *
 * "Read for facts" is the switch that means the bot may read a channel at all,
 * so it governs this too; `canReply` stays purely about whether the bot may
 * write somewhere. A channel an admin has closed must not become readable by
 * being mentioned in one that is open.
 *
 * The Discord permission check is not belt-and-braces: `channels.fetch` will
 * happily hand back a channel the bot has no right to read, and the failure
 * would otherwise surface as an exception mid-reply.
 */
export type ChannelAccess =
  | { ok: true; channel: GuildTextBasedChannel }
  | { ok: false; reason: string };

export async function resolveReadableChannel(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<ChannelAccess> {
  if (!isServedGuild(guildId)) return { ok: false, reason: 'That channel is not in the server I serve.' };
  if (!canExtractFrom(channelId)) return { ok: false, reason: 'Reading that channel has been switched off.' };

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    return { ok: false, reason: 'That is not a text channel I can see.' };
  }
  if (channel.guildId !== guildId) return { ok: false, reason: 'That channel is in a different server.' };

  const me = client.user;
  const permissions = me ? channel.permissionsFor(me) : null;
  if (
    !permissions
    || !permissions.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    return { ok: false, reason: 'Discord will not let me read that channel.' };
  }

  return { ok: true, channel };
}

/** Nobody needs every channel in a prompt, and a big server has hundreds. */
const CHANNEL_ROSTER_CAP = 100;

/**
 * The channels the bot may read, for the reply prompt. Without this the model
 * has no ids to point `read_channel` at — the prompt forbids naming a channel
 * whose id it was not given, which is what stops it inventing one.
 */
export function readableChannelRoster(guild: Guild): string {
  const lines: string[] = [];
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) continue;
    if (!canExtractFrom(channel.id)) continue;
    lines.push(`<#${channel.id}>(#${channel.name})`);
    if (lines.length >= CHANNEL_ROSTER_CAP) break;
  }
  return lines.join('\n');
}
