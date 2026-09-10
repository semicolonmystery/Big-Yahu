import type { PluginTool } from '@big-yahu/plugin-sdk';
import { withDefaults } from './config';
import {
  auditReason,
  booleanValue,
  botMember,
  guarded,
  integer,
  invocationGuild,
  isUnknownMember,
  mutationConfirmationRequired,
  requirePermission,
  snowflake,
} from './support';

// Controllers always. Anyone else only once the operator turns on
// autonomousModeration, which also lets the bot act on its own judgement.
const CONTROLLER_ONLY = {
  requiresController: true,
  controllerBypassConfig: 'autonomousModeration',
} as const;

export const memberTools: PluginTool[] = [
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enableNicknames',
    name: 'set_nickname',
    description:
      'Set or clear a member\'s server nickname. This cannot change anyone\'s global Discord username. '
      + 'Use the digits from a shown <@userId>; an empty nickname clears it.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The member id, as digits only.' },
        nickname: { type: 'string', description: 'New server nickname, at most 32 characters; empty clears it.' },
        reason: { type: 'string', description: 'Why this is being changed. Visible in Discord\'s audit log.' },
      },
      required: ['userId', 'nickname', 'reason'],
    },
    handler: guarded('enableNicknames', async (args, ctx) => {
      const userId = snowflake(args.userId, 'userId');
      if (typeof args.nickname !== 'string') throw new Error('nickname must be text.');
      const nickname = args.nickname.trim();
      if ([...nickname].length > 32) throw new Error('nickname must be at most 32 characters.');
      const reason = auditReason(ctx, args.reason);
      const confirmation = mutationConfirmationRequired(
        ctx,
        `SET NICKNAME ${userId}`,
        { userId, nickname: nickname || null, reason },
      );
      if (confirmation) return confirmation;

      const guild = invocationGuild(ctx);
      const me = await botMember(guild);
      if (userId === me.id) {
        requirePermission(me, 'ChangeNickname', 'Change Nickname');
        await me.setNickname(nickname || null, reason);
      } else {
        requirePermission(me, 'ManageNicknames', 'Manage Nicknames');
        const member = await guild.members.fetch({ user: userId, force: true });
        if (!member.manageable) throw new Error('That member is at or above the bot in the role hierarchy.');
        await member.setNickname(nickname || null, reason);
      }

      return { success: true, userId, nickname: nickname || null };
    }),
  },
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enableTimeouts',
    name: 'timeout_member',
    description:
      'Apply or remove a Discord communication timeout. Give whole minutes from 1 to 40320 (28 days), or 0 to remove it.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The member id, as digits only.' },
        minutes: { type: 'integer', minimum: 0, maximum: 40320, description: 'Timeout length; 0 removes it.' },
        reason: { type: 'string', description: 'Why. Visible in Discord\'s audit log.' },
      },
      required: ['userId', 'minutes', 'reason'],
    },
    handler: guarded('enableTimeouts', async (args, ctx) => {
      const userId = snowflake(args.userId, 'userId');
      const minutes = integer(args.minutes, 'minutes', 0, 40_320);
      const reason = auditReason(ctx, args.reason);
      const confirmation = mutationConfirmationRequired(
        ctx,
        minutes === 0 ? `REMOVE TIMEOUT ${userId}` : `TIMEOUT ${userId} FOR ${minutes} MINUTES`,
        { userId, minutes, reason },
      );
      if (confirmation) return confirmation;
      const guild = invocationGuild(ctx);
      const me = await botMember(guild);
      requirePermission(me, 'ModerateMembers', 'Timeout Members');
      const member = await guild.members.fetch({ user: userId, force: true });
      if (!member.moderatable) {
        throw new Error('That member cannot be timed out: check Administrator and the bot role hierarchy.');
      }
      const updated = await member.timeout(
        minutes === 0 ? null : minutes * 60_000,
        reason,
      );
      return {
        success: true,
        userId,
        timeoutMinutes: minutes,
        communicationDisabledUntil: updated.communicationDisabledUntil?.toISOString() ?? null,
      };
    }),
  },
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enableKicks',
    name: 'kick_member',
    description:
      'Kick one member. This is destructive. Never invent confirmation: if the tool asks for it, ask the controller '
      + 'to send the exact phrase it returns, then wait for that new message.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The member id, as digits only.' },
        reason: { type: 'string', description: 'Why. Visible in Discord\'s audit log.' },
      },
      required: ['userId', 'reason'],
    },
    handler: guarded('enableKicks', async (args, ctx) => {
      const userId = snowflake(args.userId, 'userId');
      const reason = auditReason(ctx, args.reason);
      const confirmation = mutationConfirmationRequired(ctx, `KICK ${userId}`, { userId, reason }, true);
      if (confirmation) return confirmation;

      const guild = invocationGuild(ctx);
      const member = await guild.members.fetch({ user: userId, force: true });
      if (!member.kickable) throw new Error('That member is not kickable by the bot because of permissions or role hierarchy.');
      await member.kick(reason);
      return { success: true, kicked: userId };
    }),
  },
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enableBans',
    name: 'ban_member',
    description:
      'Ban one user, whether or not they are currently in the server. Optionally delete up to seven days of their '
      + 'messages. This is destructive. Never invent confirmation: ask for the exact phrase returned by the tool.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The user id, as digits only.' },
        deleteMessageSeconds: {
          type: 'integer', minimum: 0, maximum: 604800,
          description: 'How much recent message history to delete, in seconds. Use 0 unless explicitly requested.',
        },
        reason: { type: 'string', description: 'Why. Visible in Discord\'s audit log.' },
      },
      required: ['userId', 'reason'],
    },
    handler: guarded('enableBans', async (args, ctx) => {
      const userId = snowflake(args.userId, 'userId');
      const deleteMessageSeconds = args.deleteMessageSeconds === undefined
        ? 0
        : integer(args.deleteMessageSeconds, 'deleteMessageSeconds', 0, 604_800);
      const reason = auditReason(ctx, args.reason);
      const action = deleteMessageSeconds === 0
        ? `BAN ${userId}`
        : `BAN ${userId} DELETE ${deleteMessageSeconds} SECONDS`;
      const confirmation = mutationConfirmationRequired(
        ctx,
        action,
        { userId, deleteMessageSeconds, reason },
        true,
      );
      if (confirmation) return confirmation;

      const guild = invocationGuild(ctx);
      const me = await botMember(guild);
      requirePermission(me, 'BanMembers', 'Ban Members');

      try {
        const member = await guild.members.fetch({ user: userId, force: true });
        if (!member.bannable) {
          throw new Error('That member is not bannable by the bot because of permissions or role hierarchy.');
        }
      } catch (error) {
        // Unknown Member means this is a valid pre-emptive ban. Network and
        // permission failures must not be mistaken for absence and pushed past.
        if (!isUnknownMember(error)) throw error;
      }

      await guild.members.ban(userId, { deleteMessageSeconds, reason });
      return { success: true, banned: userId, deleteMessageSeconds };
    }),
  },
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enableBans',
    name: 'unban_member',
    description: 'Remove one user\'s server ban. This does not add them back to the server or restore deleted messages.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The banned user id, as digits only.' },
        reason: { type: 'string', description: 'Why. Visible in Discord\'s audit log.' },
      },
      required: ['userId', 'reason'],
    },
    handler: guarded('enableBans', async (args, ctx) => {
      const userId = snowflake(args.userId, 'userId');
      const reason = auditReason(ctx, args.reason);
      const confirmation = mutationConfirmationRequired(ctx, `UNBAN ${userId}`, { userId, reason });
      if (confirmation) return confirmation;
      const guild = invocationGuild(ctx);
      requirePermission(await botMember(guild), 'BanMembers', 'Ban Members');
      await guild.members.unban(userId, reason);
      return { success: true, unbanned: userId };
    }),
  },
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enableMemberRoles',
    name: 'set_member_role',
    description:
      'Add or remove one role on one member without replacing their other roles. Use inspect_discord first if the role id is unknown.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        userId: { type: 'string', description: 'The member id, as digits only.' },
        roleId: { type: 'string', description: 'The role id, as digits only.' },
        reason: { type: 'string', description: 'Why. Visible in Discord\'s audit log.' },
      },
      required: ['action', 'userId', 'roleId', 'reason'],
    },
    handler: guarded('enableMemberRoles', async (args, ctx) => {
      if (args.action !== 'add' && args.action !== 'remove') throw new Error('action must be add or remove.');
      const userId = snowflake(args.userId, 'userId');
      const roleId = snowflake(args.roleId, 'roleId');
      const reason = auditReason(ctx, args.reason);
      const guild = invocationGuild(ctx);
      const me = await botMember(guild);
      requirePermission(me, 'ManageRoles', 'Manage Roles');
      if (roleId === guild.id) throw new Error('The @everyone role cannot be assigned or removed.');

      const [member, role] = await Promise.all([
        guild.members.fetch({ user: userId, force: true }),
        guild.roles.fetch(roleId, { force: true }),
      ]);
      if (!role) throw new Error('That role does not exist.');
      if (!role.editable) throw new Error('That role is managed or at or above the bot\'s highest role.');
      if (!member.manageable) throw new Error('That member is at or above the bot in the role hierarchy.');

      const administratorGrant = args.action === 'add' && role.permissions.has('Administrator');
      if (administratorGrant) {
        if (!withDefaults(ctx.getConfig()).allowAdministratorPermission) {
          throw new Error('Assigning an Administrator role is disabled in the plugin settings.');
        }
        requirePermission(me, 'Administrator');
      }
      const confirmation = mutationConfirmationRequired(
        ctx,
        `${args.action === 'add' ? 'ADD' : 'REMOVE'}${administratorGrant ? ' ADMINISTRATOR' : ''} ROLE ${roleId} `
          + `${args.action === 'add' ? 'TO' : 'FROM'} ${userId}`,
        { action: args.action, userId, roleId, reason },
        administratorGrant,
      );
      if (confirmation) return confirmation;

      if (args.action === 'add') await member.roles.add(role, reason);
      else await member.roles.remove(role, reason);
      return { success: true, action: args.action, userId, roleId, roleName: role.name };
    }),
  },
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enableVoiceModeration',
    name: 'set_voice_state',
    description:
      'Server-mute, server-deafen, move or disconnect a member in voice. Include only the fields that should change.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'The member id, as digits only.' },
        muted: { type: 'boolean', description: 'Set or clear server mute.' },
        deafened: { type: 'boolean', description: 'Set or clear server deafen.' },
        channelId: { type: 'string', description: 'Voice/stage channel to move them to.' },
        disconnect: { type: 'boolean', description: 'True to disconnect them instead of moving them.' },
        reason: { type: 'string', description: 'Why. Visible in Discord\'s audit log.' },
      },
      required: ['userId', 'reason'],
    },
    handler: guarded('enableVoiceModeration', async (args, ctx) => {
      const userId = snowflake(args.userId, 'userId');
      const muted = booleanValue(args.muted, 'muted');
      const deafened = booleanValue(args.deafened, 'deafened');
      const disconnect = booleanValue(args.disconnect, 'disconnect') ?? false;
      const reason = auditReason(ctx, args.reason);
      if (disconnect && args.channelId !== undefined) throw new Error('Use channelId or disconnect, not both.');
      if (muted === undefined && deafened === undefined && args.channelId === undefined && !disconnect) {
        throw new Error('Give at least one voice state to change.');
      }

      const guild = invocationGuild(ctx);
      const me = await botMember(guild);

      let destination: string | null | undefined;
      if (disconnect) {
        destination = null;
      } else if (args.channelId !== undefined) {
        const channelId = snowflake(args.channelId, 'channelId');
        const channel = await guild.channels.fetch(channelId, { force: true });
        if (!channel?.isVoiceBased()) throw new Error('channelId must name a voice or stage channel.');
        const destinationPermissions = me.permissionsIn(channel);
        if (!destinationPermissions.has('Connect')) {
          throw new Error('The bot needs Connect in the destination voice channel.');
        }
        if (!destinationPermissions.has('MoveMembers')) {
          throw new Error('The bot needs Move Members in the destination voice channel.');
        }
        destination = channelId;
      }

      const member = await guild.members.fetch({ user: userId, force: true });
      if (!member.voice.channelId) throw new Error('That member is not connected to a voice channel.');
      const sourceChannel = await guild.channels.fetch(member.voice.channelId, { force: true });
      if (!sourceChannel?.isVoiceBased()) throw new Error('The member\'s current voice channel is unavailable.');
      const sourcePermissions = me.permissionsIn(sourceChannel);
      if (muted !== undefined && !sourcePermissions.has('MuteMembers')) {
        throw new Error('The bot needs Mute Members in the member\'s current voice channel.');
      }
      if (deafened !== undefined && !sourcePermissions.has('DeafenMembers')) {
        throw new Error('The bot needs Deafen Members in the member\'s current voice channel.');
      }
      if (destination !== undefined && !sourcePermissions.has('MoveMembers')) {
        throw new Error('The bot needs Move Members in the member\'s current voice channel.');
      }

      const voiceChanges = [
        ...(muted === undefined ? [] : [`MUTE ${muted ? 'ON' : 'OFF'}`]),
        ...(deafened === undefined ? [] : [`DEAFEN ${deafened ? 'ON' : 'OFF'}`]),
        ...(destination === undefined ? [] : [destination === null ? 'DISCONNECT' : `MOVE TO ${destination}`]),
      ];
      const confirmation = mutationConfirmationRequired(
        ctx,
        `VOICE ${userId} ${voiceChanges.join(' ')}`,
        { userId, muted, deafened, destination, reason },
      );
      if (confirmation) return confirmation;
      await member.edit({
        ...(muted === undefined ? {} : { mute: muted }),
        ...(deafened === undefined ? {} : { deaf: deafened }),
        ...(destination === undefined ? {} : { channel: destination }),
        reason,
      });
      return { success: true, userId, muted, deafened, channelId: destination };
    }),
  },
];
