import { ChannelType } from 'discord.js';
import type { PluginTool } from '@big-yahu/plugin-sdk';
import {
  botMember,
  guarded,
  integer,
  invocationGuild,
  isUnknownBan,
  permissionCatalogue,
  permissionSummary,
  requirePermission,
  snowflake,
} from './support';

const SCOPES = ['overview', 'permission_flags', 'roles', 'channels', 'member', 'role', 'channel', 'bans'] as const;

function limit(value: unknown): number {
  return value === undefined ? 25 : integer(value, 'limit', 1, 50);
}

function roleView(role: {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  editable: boolean;
  hoist: boolean;
  mentionable: boolean;
  hexColor: string;
  permissions: Parameters<typeof permissionSummary>[0];
}): Record<string, unknown> {
  return {
    id: role.id,
    name: role.name,
    position: role.position,
    managed: role.managed,
    editableByBot: role.editable,
    hoist: role.hoist,
    mentionable: role.mentionable,
    color: role.hexColor,
    permissions: permissionSummary(role.permissions),
  };
}

export const inspectionTool: PluginTool = {
  requiresController: true,
  enabledByConfig: 'enableInspection',
  name: 'inspect_discord',
  description:
    'Inspect this request\'s Discord server before changing it. Can show the bot\'s effective permissions, every '
    + 'current permission flag, roles, channels, one member/role/channel, or bans. Use IDs from this result in mutation tools.',
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: [...SCOPES] },
      targetId: { type: 'string', description: 'Required for member, role or channel.' },
      query: {
        type: 'string',
        description: 'Optional case-insensitive name/id filter for roles or channels; for bans, use an exact user id.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum rows for a list; defaults to 25.' },
    },
    required: ['scope'],
  },
  handler: guarded('enableInspection', async (args, ctx) => {
    if (typeof args.scope !== 'string' || !SCOPES.includes(args.scope as (typeof SCOPES)[number])) {
      throw new Error(`scope must be one of: ${SCOPES.join(', ')}.`);
    }
    const scope = args.scope as (typeof SCOPES)[number];
    if (scope === 'permission_flags') {
      return { success: true, permissions: permissionCatalogue() };
    }

    const guild = invocationGuild(ctx);
    const me = await botMember(guild);
    if (args.query !== undefined && typeof args.query !== 'string') throw new Error('query must be text.');
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if ([...query].length > 100) throw new Error('query must be at most 100 characters.');
    const needle = query.toLowerCase();
    const take = limit(args.limit);

    if (scope === 'overview') {
      return {
        success: true,
        guild: {
          id: guild.id,
          name: guild.name,
          ownerId: guild.ownerId,
          memberCount: guild.memberCount,
          rolesCached: guild.roles.cache.size,
          channelsCached: guild.channels.cache.size,
        },
        bot: {
          id: me.id,
          displayName: me.displayName,
          highestRole: { id: me.roles.highest.id, name: me.roles.highest.name, position: me.roles.highest.position },
          permissions: permissionSummary(me.permissions),
        },
      };
    }

    if (scope === 'roles') {
      const roles = [...(await guild.roles.fetch()).values()]
        .filter((role) => !needle || role.id.includes(needle) || role.name.toLowerCase().includes(needle))
        .sort((a, b) => b.position - a.position);
      return { success: true, total: roles.length, roles: roles.slice(0, take).map(roleView) };
    }

    if (scope === 'channels') {
      const channels = [...(await guild.channels.fetch()).values()]
        .filter((channel) => channel !== null)
        .filter((channel) => {
          const name = 'name' in channel ? channel.name : '';
          return !needle || channel.id.includes(needle) || name.toLowerCase().includes(needle);
        })
        .sort((a, b) => ('rawPosition' in a ? a.rawPosition : 0) - ('rawPosition' in b ? b.rawPosition : 0));
      return {
        success: true,
        total: channels.length,
        channels: channels.slice(0, take).map((channel) => ({
          id: channel.id,
          name: 'name' in channel ? channel.name : '',
          type: ChannelType[channel.type],
          parentId: 'parentId' in channel ? channel.parentId : null,
        })),
      };
    }

    if (scope === 'bans') {
      requirePermission(me, 'BanMembers', 'Ban Members');
      if (query) {
        const userId = snowflake(query, 'query');
        try {
          const ban = await guild.bans.fetch(userId);
          return {
            success: true,
            total: 1,
            bans: [{ userId: ban.user.id, username: ban.user.username, reason: ban.reason }],
          };
        } catch (error) {
          if (isUnknownBan(error)) return { success: true, total: 0, bans: [] };
          throw error;
        }
      }
      const bans = [...(await guild.bans.fetch({ limit: take })).values()];
      return {
        success: true,
        total: bans.length,
        bans: bans.map((ban) => ({
          userId: ban.user.id,
          username: ban.user.username,
          reason: ban.reason,
        })),
      };
    }

    const targetId = snowflake(args.targetId, 'targetId');
    if (scope === 'member') {
      const member = await guild.members.fetch({ user: targetId, force: true });
      return {
        success: true,
        member: {
          id: member.id,
          username: member.user.username,
          displayName: member.displayName,
          nickname: member.nickname,
          roles: [...member.roles.cache.values()]
            .filter((role) => role.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .map((role) => ({ id: role.id, name: role.name, position: role.position })),
          permissions: permissionSummary(member.permissions),
          timedOutUntil: member.communicationDisabledUntil?.toISOString() ?? null,
          manageableByBot: member.manageable,
          moderatableByBot: member.moderatable,
          kickableByBot: member.kickable,
          bannableByBot: member.bannable,
        },
      };
    }

    if (scope === 'role') {
      const role = await guild.roles.fetch(targetId, { force: true });
      if (!role) throw new Error('That role does not exist.');
      return { success: true, role: roleView(role) };
    }

    const channel = await guild.channels.fetch(targetId, { force: true });
    if (!channel) throw new Error('That channel does not exist.');
    const overwrites = channel.isThread() || !('permissionOverwrites' in channel)
      ? []
      : [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
          targetId: overwrite.id,
          targetType: overwrite.type === 0 ? 'role' : 'member',
          allow: permissionSummary(overwrite.allow),
          deny: permissionSummary(overwrite.deny),
        }));
    return {
      success: true,
      channel: {
        id: channel.id,
        name: 'name' in channel ? channel.name : '',
        type: ChannelType[channel.type],
        parentId: 'parentId' in channel ? channel.parentId : null,
        botPermissions: channel.isThread() ? null : permissionSummary(me.permissionsIn(channel)),
        overwrites,
      },
    };
  }),
};
