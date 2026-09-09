import { Router } from 'express';
import { ChannelType } from 'discord.js';
import { discordClient } from '../../bot/client';
import { env } from '../../env';
import { listChannelSettings, setChannelPermissions } from '../../db/repositories/channelSettingsRepo';
import type { ChannelPermission } from '@shared/types';

export const channelsRouter = Router();

/**
 * The guild's text channels merged with their stored permissions. Channels the
 * admin has never touched come back allowed, which is what the bot does.
 */
/** A channel configured but not currently visible — deleted, or the bot is offline. */
function notVisibleName(channelId: string): string {
  return `#${channelId} (not visible)`;
}

function displayName(channelId: string): string {
  const channel = discordClient.channels.cache.get(channelId);
  return channel && 'name' in channel && typeof channel.name === 'string'
    ? channel.name
    : notVisibleName(channelId);
}

channelsRouter.get('/', (_req, res) => {
  const stored = new Map(listChannelSettings().map((row) => [row.channelId, row]));
  const channels: ChannelPermission[] = [];

  const guild = env.discordGuildId
    ? discordClient.guilds.cache.get(env.discordGuildId)
    : discordClient.guilds.cache.first();

  for (const channel of guild?.channels.cache.values() ?? []) {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) continue;
    const row = stored.get(channel.id);
    channels.push({
      channelId: channel.id,
      name: channel.name,
      canReply: row?.canReply ?? true,
      canExtract: row?.canExtract ?? true,
    });
    stored.delete(channel.id);
  }

  // Anything configured but no longer visible — the bot may be offline, or the
  // channel deleted. Still listed so a stale rule can be found and cleared.
  for (const row of stored.values()) {
    channels.push({
      channelId: row.channelId,
      name: notVisibleName(row.channelId),
      canReply: row.canReply,
      canExtract: row.canExtract,
    });
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ success: true, data: { channels, botOnline: discordClient.isReady() } });
});

channelsRouter.patch('/:channelId', (req, res) => {
  const body = req.body as { canReply?: unknown; canExtract?: unknown };
  if (
    (body?.canReply !== undefined && typeof body.canReply !== 'boolean')
    || (body?.canExtract !== undefined && typeof body.canExtract !== 'boolean')
  ) {
    res.status(400).json({ success: false, error: 'canReply and canExtract must be booleans' });
    return;
  }

  const channelId = String(req.params.channelId);
  const guildId =
    discordClient.channels.cache.get(channelId)?.isTextBased() && 'guildId' in (discordClient.channels.cache.get(channelId) ?? {})
      ? String((discordClient.channels.cache.get(channelId) as { guildId: string }).guildId)
      : (env.discordGuildId ?? '');

  const next = setChannelPermissions(channelId, guildId, {
    canReply: body.canReply as boolean | undefined,
    canExtract: body.canExtract as boolean | undefined,
  });
  // The whole ChannelPermission, name included: the panel swaps this row in
  // wholesale, and a partial reply left it without a name.
  const updated: ChannelPermission = { channelId, name: displayName(channelId), ...next };
  res.json({ success: true, data: updated });
});
