import {
  OverwriteType,
  PermissionsBitField,
  type PermissionOverwriteOptions,
  type PermissionsString,
  type RoleEditOptions,
} from 'discord.js';
import type { PluginTool } from '@big-yahu/plugin-sdk';
import { withDefaults } from './config';
import {
  accessDenied,
  auditReason,
  booleanValue,
  botMember,
  guarded,
  invocationGuild,
  mutationConfirmationRequired,
  optionalText,
  permissionNames,
  permissionSummary,
  requirePermission,
  requirePermissions,
  serialise,
  snowflake,
} from './support';

const CONTROLLER_ONLY = { requiresController: true } as const;

function roleColor(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.trim())) {
    throw new Error('color must be a six-digit hex colour such as #5865F2.');
  }
  return Number.parseInt(value.trim().slice(1), 16);
}

function overlap(...groups: PermissionsString[][]): PermissionsString[] {
  const seen = new Set<PermissionsString>();
  const duplicates = new Set<PermissionsString>();
  for (const group of groups) {
    for (const name of group) {
      if (seen.has(name)) duplicates.add(name);
      seen.add(name);
    }
  }
  return [...duplicates];
}

export const permissionTools: PluginTool[] = [
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enableRoleManagement',
    name: 'create_role',
    description:
      'Create a Discord role with an explicit permission set. Permission names are format-insensitive; use '
      + 'inspect_discord with scope permission_flags for the current complete list.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Role name, 1-100 characters.' },
        permissions: { type: 'array', items: { type: 'string' }, description: 'Permissions to grant; empty means none.' },
        color: { type: 'string', description: 'Optional six-digit hex colour, for example #5865F2.' },
        hoist: { type: 'boolean', description: 'Show members separately in the member list.' },
        mentionable: { type: 'boolean', description: 'Allow anyone with permission to mention this role.' },
        reason: { type: 'string', description: 'Why. Visible in Discord\'s audit log.' },
      },
      required: ['name', 'permissions', 'reason'],
    },
    handler: guarded('enableRoleManagement', async (args, ctx) => {
      const name = optionalText(args.name, 'name', 100);
      if (!name) throw new Error('name is required.');
      const permissions = permissionNames(args.permissions, 'permissions');
      const color = roleColor(args.color);
      const hoist = booleanValue(args.hoist, 'hoist');
      const mentionable = booleanValue(args.mentionable, 'mentionable');
      const reason = auditReason(ctx, args.reason);
      const config = withDefaults(ctx.getConfig());
      const administratorGrant = permissions.includes('Administrator');
      if (administratorGrant) {
        if (!config.allowAdministratorPermission) {
          throw new Error('Granting Administrator is disabled in the plugin settings.');
        }
      }

      const guild = invocationGuild(ctx);
      const me = await botMember(guild);
      requirePermission(me, 'ManageRoles', 'Manage Roles');
      requirePermissions(me, permissions);
      const confirmation = mutationConfirmationRequired(
        ctx,
        administratorGrant ? 'CREATE ADMINISTRATOR ROLE' : 'CREATE ROLE',
        { name, permissions, color, hoist, mentionable, reason },
        administratorGrant,
      );
      if (confirmation) return confirmation;
      const role = await guild.roles.create({
        name,
        permissions: new PermissionsBitField(permissions),
        ...(color === undefined ? {} : { colors: { primaryColor: color } }),
        ...(hoist === undefined ? {} : { hoist }),
        ...(mentionable === undefined ? {} : { mentionable }),
        reason,
      });
      return { success: true, roleId: role.id, roleName: role.name, permissions: permissionSummary(role.permissions) };
    }),
  },
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enableRoleManagement',
    name: 'edit_role',
    description:
      'Edit a role and/or grant and revoke individual permissions without erasing unrelated or future permission bits. '
      + 'Managed roles and roles at or above the bot cannot be changed.',
    parameters: {
      type: 'object',
      properties: {
        roleId: { type: 'string', description: 'The role id, as digits only.' },
        name: { type: 'string', description: 'Optional new role name, 1-100 characters.' },
        color: { type: 'string', description: 'Optional six-digit hex colour, for example #5865F2.' },
        hoist: { type: 'boolean' },
        mentionable: { type: 'boolean' },
        grantPermissions: { type: 'array', items: { type: 'string' } },
        revokePermissions: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string', description: 'Why. Visible in Discord\'s audit log.' },
      },
      required: ['roleId', 'reason'],
    },
    handler: guarded('enableRoleManagement', async (args, ctx) => {
      const roleId = snowflake(args.roleId, 'roleId');
      const name = optionalText(args.name, 'name', 100);
      const color = roleColor(args.color);
      const hoist = booleanValue(args.hoist, 'hoist');
      const mentionable = booleanValue(args.mentionable, 'mentionable');
      const grants = permissionNames(args.grantPermissions, 'grantPermissions');
      const revokes = permissionNames(args.revokePermissions, 'revokePermissions');
      const reason = auditReason(ctx, args.reason);
      const duplicates = overlap(grants, revokes);
      if (duplicates.length > 0) throw new Error(`A permission cannot be granted and revoked together: ${duplicates.join(', ')}.`);
      if (name === undefined && color === undefined && hoist === undefined && mentionable === undefined
        && grants.length === 0 && revokes.length === 0) {
        throw new Error('Give at least one role field or permission to change.');
      }

      const config = withDefaults(ctx.getConfig());
      if (grants.includes('Administrator')) {
        if (!config.allowAdministratorPermission) {
          throw new Error('Granting Administrator is disabled in the plugin settings.');
        }
      }

      return serialise(`role:${ctx.invocation.guildId}:${roleId}`, async () => {
        const denied = accessDenied(ctx, 'enableRoleManagement');
        if (denied) return denied;
        if (grants.includes('Administrator') && !withDefaults(ctx.getConfig()).allowAdministratorPermission) {
          throw new Error('Granting Administrator is disabled in the plugin settings.');
        }
        const guild = invocationGuild(ctx);
        const me = await botMember(guild);
        requirePermission(me, 'ManageRoles', 'Manage Roles');
        requirePermissions(me, grants);
        const role = await guild.roles.fetch(roleId, { force: true });
        if (!role) throw new Error('That role does not exist.');
        if (!role.editable) throw new Error('That role is managed or at or above the bot\'s highest role.');
        if (role.id === guild.id && (name !== undefined || color !== undefined || hoist !== undefined || mentionable !== undefined)) {
          throw new Error('Only permissions can be changed on the @everyone role.');
        }

        const permissions = new PermissionsBitField(role.permissions.bitfield);
        permissions.add(grants);
        permissions.remove(revokes);
        const action = grants.includes('Administrator')
          ? roleId === ctx.invocation.guildId
            ? `GRANT ADMINISTRATOR TO EVERYONE ${roleId}`
            : `GRANT ADMINISTRATOR ${roleId}`
          : `EDIT ROLE ${roleId}`;
        const confirmation = mutationConfirmationRequired(
          ctx,
          action,
          { roleId, name, color, hoist, mentionable, grants, revokes, reason },
          grants.includes('Administrator'),
        );
        if (confirmation) return confirmation;
        const options: RoleEditOptions = {
          ...(name === undefined ? {} : { name }),
          ...(color === undefined ? {} : { colors: { primaryColor: color } }),
          ...(hoist === undefined ? {} : { hoist }),
          ...(mentionable === undefined ? {} : { mentionable }),
          ...(grants.length === 0 && revokes.length === 0 ? {} : { permissions }),
          reason,
        };
        const updated = await guild.roles.edit(role, options);
        return {
          success: true,
          roleId: updated.id,
          roleName: updated.name,
          permissions: permissionSummary(updated.permissions),
        };
      });
    }),
  },
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enableRoleManagement',
    name: 'delete_role',
    description:
      'Permanently delete one role. Never invent confirmation: if the tool asks for it, ask the controller to '
      + 'send the exact phrase it returns, then wait for that new message.',
    parameters: {
      type: 'object',
      properties: {
        roleId: { type: 'string', description: 'The role id, as digits only.' },
        reason: { type: 'string', description: 'Why. Visible in Discord\'s audit log.' },
      },
      required: ['roleId', 'reason'],
    },
    handler: guarded('enableRoleManagement', async (args, ctx) => {
      const roleId = snowflake(args.roleId, 'roleId');
      if (roleId === ctx.invocation.guildId) throw new Error('The @everyone role cannot be deleted.');
      const reason = auditReason(ctx, args.reason);
      const confirmation = mutationConfirmationRequired(ctx, `DELETE ROLE ${roleId}`, { roleId, reason }, true);
      if (confirmation) return confirmation;

      const guild = invocationGuild(ctx);
      const me = await botMember(guild);
      requirePermission(me, 'ManageRoles', 'Manage Roles');
      const role = await guild.roles.fetch(roleId, { force: true });
      if (!role) throw new Error('That role does not exist.');
      if (!role.editable) throw new Error('That role is managed or at or above the bot\'s highest role.');
      await guild.roles.delete(role, reason);
      return { success: true, deletedRoleId: roleId, deletedRoleName: role.name };
    }),
  },
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enableChannelPermissions',
    name: 'set_channel_permissions',
    description:
      'Edit or delete one channel permission overwrite for a role or member. `allow`, `deny` and `inherit` '
      + 'change only named bits and preserve everything else. Deleting removes the whole overwrite and restores inheritance.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['edit', 'delete'] },
        channelId: { type: 'string', description: 'Guild channel id, as digits only.' },
        targetType: { type: 'string', enum: ['role', 'member'] },
        targetId: { type: 'string', description: 'Role or member id, as digits only.' },
        allow: { type: 'array', items: { type: 'string' }, description: 'Permission names to explicitly allow.' },
        deny: { type: 'array', items: { type: 'string' }, description: 'Permission names to explicitly deny.' },
        inherit: { type: 'array', items: { type: 'string' }, description: 'Permission names to return to neutral/inherited.' },
        reason: { type: 'string', description: 'Why. Visible in Discord\'s audit log.' },
      },
      required: ['action', 'channelId', 'targetType', 'targetId', 'reason'],
    },
    handler: guarded('enableChannelPermissions', async (args, ctx) => {
      if (args.action !== 'edit' && args.action !== 'delete') throw new Error('action must be edit or delete.');
      if (args.targetType !== 'role' && args.targetType !== 'member') {
        throw new Error('targetType must be role or member.');
      }
      const channelId = snowflake(args.channelId, 'channelId');
      const targetId = snowflake(args.targetId, 'targetId');
      const reason = auditReason(ctx, args.reason);
      const allow = permissionNames(args.allow, 'allow');
      const deny = permissionNames(args.deny, 'deny');
      const inherit = permissionNames(args.inherit, 'inherit');
      const duplicates = overlap(allow, deny, inherit);
      if (duplicates.length > 0) {
        throw new Error(`A permission can have only one overwrite state: ${duplicates.join(', ')}.`);
      }
      if (args.action === 'edit' && allow.length === 0 && deny.length === 0 && inherit.length === 0) {
        throw new Error('Give at least one permission to allow, deny or inherit.');
      }
      if (args.action === 'delete' && (allow.length > 0 || deny.length > 0 || inherit.length > 0)) {
        throw new Error('Do not give allow, deny or inherit when deleting an overwrite.');
      }
      if ([...allow, ...deny, ...inherit].includes('Administrator')) {
        throw new Error('Administrator is guild-wide and cannot be changed by a channel overwrite.');
      }

      return serialise(`overwrite:${channelId}:${targetId}`, async () => {
        const denied = accessDenied(ctx, 'enableChannelPermissions');
        if (denied) return denied;
        const guild = invocationGuild(ctx);
        const channel = await guild.channels.fetch(channelId, { force: true });
        if (!channel || channel.isThread() || !('permissionOverwrites' in channel)) {
          throw new Error('channelId must name a non-thread guild channel.');
        }
        const me = await botMember(guild);
        if (!me.permissionsIn(channel).has('ManageRoles')) {
          throw new Error('The bot needs Manage Permissions in that channel.');
        }

        if (args.targetType === 'role') {
          const role = await guild.roles.fetch(targetId, { force: true });
          if (!role) throw new Error('That role does not exist.');
        } else {
          await guild.members.fetch({ user: targetId, force: true });
        }

        const targetLabel = args.targetType === 'role' ? 'ROLE' : 'MEMBER';
        const confirmation = mutationConfirmationRequired(
          ctx,
          `${args.action === 'delete' ? 'DELETE' : 'EDIT'} ${targetLabel} OVERWRITE ${targetId} IN ${channelId}`,
          { action: args.action, channelId, targetType: args.targetType, targetId, allow, deny, inherit, reason },
          args.action === 'delete',
        );
        if (confirmation) return confirmation;

        if (args.action === 'delete') {
          await channel.permissionOverwrites.delete(targetId, reason);
          return { success: true, deleted: true, channelId, targetId, targetType: args.targetType };
        }

        const changes: PermissionOverwriteOptions = {};
        for (const name of allow) changes[name] = true;
        for (const name of deny) changes[name] = false;
        for (const name of inherit) changes[name] = null;
        await channel.permissionOverwrites.edit(targetId, changes, {
          type: args.targetType === 'role' ? OverwriteType.Role : OverwriteType.Member,
          reason,
        });
        return { success: true, channelId, targetId, targetType: args.targetType, allow, deny, inherit };
      });
    }),
  },
];
