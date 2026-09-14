import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Client, Guild } from 'discord.js';

const state = vi.hoisted(() => ({ allowed: new Set<string>(['channel']) }));
vi.mock('../../src/server/env', () => ({ isServedGuild: (id: string) => id === 'guild' }));
vi.mock('../../src/server/db/repositories/channelSettingsRepo', () => ({ canExtractFrom: (id: string) => state.allowed.has(id) }));

import { readableChannelRoster, resolveReadableChannel } from '../../src/server/bot/channelAccess';

function fixture(options: { guildId?: string; text?: boolean; dm?: boolean; permissions?: bigint[]; user?: boolean } = {}) {
  const permissions = new Set(options.permissions ?? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
  const channel = {
    id: 'channel', guildId: options.guildId ?? 'guild',
    isTextBased: () => options.text ?? true, isDMBased: () => options.dm ?? false,
    permissionsFor: () => ({ has: (permission: bigint) => permissions.has(permission) }),
  };
  const fetch = vi.fn(async () => channel);
  const client = { user: options.user === false ? null : { id: 'bot' }, channels: { fetch } } as unknown as Client;
  return { channel, fetch, client };
}

beforeEach(() => { state.allowed.clear(); state.allowed.add('channel'); });

describe('cross-channel access gate', () => {
  it('permits configured readable channels in the served guild', async () => {
    const { client, channel } = fixture();
    expect(await resolveReadableChannel(client, 'guild', 'channel')).toEqual({ ok: true, channel });
  });

  it('rejects another guild before asking Discord', async () => {
    const { client, fetch } = fixture();
    expect(await resolveReadableChannel(client, 'other', 'channel')).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects opted-out or unconfigured channels before asking Discord', async () => {
    const { client, fetch } = fixture();
    state.allowed.clear();
    expect(await resolveReadableChannel(client, 'guild', 'channel')).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { guildId: 'other' }, { text: false }, { dm: true }, { permissions: [] },
    { permissions: [PermissionFlagsBits.ViewChannel] }, { permissions: [PermissionFlagsBits.ReadMessageHistory] }, { user: false },
  ])('rejects inaccessible Discord channel state %#', async (options) => {
    const { client } = fixture(options);
    expect(await resolveReadableChannel(client, 'guild', 'channel')).toMatchObject({ ok: false });
  });

  it('treats a Discord fetch failure as denied access', async () => {
    const { client, fetch } = fixture();
    fetch.mockRejectedValueOnce(new Error('Missing Access'));
    expect(await resolveReadableChannel(client, 'guild', 'channel')).toMatchObject({ ok: false });
  });

  it('lists only opted-in text/announcement channels and bounds the roster', () => {
    const channels = Array.from({ length: 110 }, (_, index) => ({ id: String(index), name: `channel-${index}`, type: ChannelType.GuildText }));
    for (const channel of channels) state.allowed.add(channel.id);
    const guild = { channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) } } as unknown as Guild;
    expect(readableChannelRoster(guild)).toHaveLength(100);

    state.allowed.clear();
    state.allowed.add('0');
    state.allowed.add('1');
    channels[0].type = ChannelType.GuildAnnouncement;
    channels[1].type = ChannelType.GuildVoice;
    expect(readableChannelRoster(guild)).toEqual([{ id: '0', name: 'channel-0' }]);
  });
});
