import { describe, expect, it, vi } from 'vitest';
import {
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
  type Client,
  type PermissionsString,
} from 'discord.js';
import type { PluginTool, PluginToolContext } from '@big-yahu/plugin-sdk';
import discordAdminPlugin from '../../src/server/plugins/bundled/discord-admin';
import {
  DEFAULT_CONFIG,
  type DiscordAdminConfig,
} from '../../src/server/plugins/bundled/discord-admin/config';
import { auditReason } from '../../src/server/plugins/bundled/discord-admin/support';

const GUILD_ID = '100000000000000001';
const CHANNEL_ID = '200000000000000001';
const SOURCE_VOICE_CHANNEL_ID = '200000000000000002';
const REQUESTER_ID = '300000000000000001';
const BOT_ID = '400000000000000001';
const USER_ID = '500000000000000001';
const SECOND_USER_ID = '500000000000000002';
const ROLE_ID = '600000000000000001';

const EXPECTED_GATES = {
  inspect_discord: 'enableInspection',
  read_audit_log: 'enableAuditLog',
  set_nickname: 'enableNicknames',
  timeout_member: 'enableTimeouts',
  kick_member: 'enableKicks',
  ban_member: 'enableBans',
  unban_member: 'enableBans',
  set_member_role: 'enableMemberRoles',
  set_voice_state: 'enableVoiceModeration',
  create_role: 'enableRoleManagement',
  edit_role: 'enableRoleManagement',
  delete_role: 'enableRoleManagement',
  set_channel_permissions: 'enableChannelPermissions',
} as const satisfies Record<string, keyof DiscordAdminConfig>;

const tools = discordAdminPlugin.tools ?? [];

function tool(name: keyof typeof EXPECTED_GATES): PluginTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Discord Admin tool: ${name}`);
  return found;
}

function permissions(...names: PermissionsString[]): PermissionsBitField {
  return new PermissionsBitField(names);
}

interface ContextOptions {
  controller?: boolean;
  config?: Partial<DiscordAdminConfig>;
  guild?: unknown;
  requestContent?: string;
  onDiscordAccess?: () => void;
  onGuildAccess?: () => void;
}

function context(options: ContextOptions = {}): PluginToolContext {
  const client = {
    user: { id: BOT_ID },
    guilds: {
      cache: {
        get(id: string) {
          options.onGuildAccess?.();
          return id === GUILD_ID ? options.guild : undefined;
        },
      },
    },
  } as unknown as Client;
  const value = {
    invocation: {
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      messageId: '700000000000000001',
      requesterId: REQUESTER_ID,
      requesterIsController: options.controller ?? true,
      requestContent: options.requestContent ?? 'please do it',
    },
    getConfig: () => ({ ...DEFAULT_CONFIG, ...options.config }),
  } as Record<string, unknown>;
  Object.defineProperty(value, 'discordClient', {
    enumerable: true,
    get() {
      options.onDiscordAccess?.();
      return client;
    },
  });
  return value as unknown as PluginToolContext;
}

function botMember(...granted: PermissionsString[]): Record<string, unknown> {
  return {
    id: BOT_ID,
    permissions: permissions(...granted),
    roles: { highest: { id: ROLE_ID, name: 'Bot', position: 10 } },
  };
}

function confirmationPhrase(result: unknown): string {
  expect(result).toMatchObject({ success: false });
  if (typeof result !== 'object' || result === null
    || typeof (result as Record<string, unknown>).confirmationRequired !== 'string') {
    throw new Error('Mutation did not return a confirmation phrase');
  }
  const phrase = (result as { confirmationRequired: string }).confirmationRequired;
  expect(phrase).toMatch(/^CONFIRM .+ [A-F0-9]{24}$/);
  return phrase;
}

async function requestConfirmation(
  name: keyof typeof EXPECTED_GATES,
  args: Record<string, unknown>,
  options: ContextOptions = {},
): Promise<string> {
  const result = await tool(name).handler(args, context({
    ...options,
    requestContent: 'not confirmed',
  }));
  return confirmationPhrase(result);
}

async function requestAndConfirm(
  name: keyof typeof EXPECTED_GATES,
  args: Record<string, unknown>,
  options: ContextOptions = {},
): Promise<{ phrase: string; result: unknown }> {
  const phrase = await requestConfirmation(name, args, options);
  const result = await tool(name).handler(args, context({
    ...options,
    requestContent: `<@${BOT_ID}> ${phrase}`,
  }));
  return { phrase, result };
}

describe('Discord Admin plugin declarations and gates', () => {
  it('puts every tool behind the matching controller and boolean config gates', () => {
    expect(Object.fromEntries(tools.map((entry) => [entry.name, entry.enabledByConfig])))
      .toEqual(EXPECTED_GATES);

    for (const entry of tools) {
      expect(entry.requiresController, entry.name).toBe(true);
      const configName = entry.enabledByConfig;
      const field = discordAdminPlugin.configSchema?.find((candidate) => candidate.name === configName);
      expect(field?.type, entry.name).toBe('boolean');
      expect(typeof discordAdminPlugin.defaultConfig?.[configName ?? ''], entry.name).toBe('boolean');
    }
    expect(discordAdminPlugin.configSchema?.find(
      (candidate) => candidate.name === 'requireMutationConfirmation',
    )?.type).toBe('boolean');
    expect(discordAdminPlugin.defaultConfig?.requireMutationConfirmation).toBe(true);
  });

  it.each(Object.entries(EXPECTED_GATES))(
    '%s refuses non-controllers and a disabled capability before touching Discord',
    async (name, configName) => {
      const selected = tool(name as keyof typeof EXPECTED_GATES);
      let discordAccesses = 0;
      const touched = (): void => { discordAccesses += 1; };

      await expect(selected.handler({}, context({ controller: false, onDiscordAccess: touched })))
        .resolves.toEqual({
          success: false,
          error: 'Discord administration is restricted to configured Big Yahu controllers.',
        });
      expect(discordAccesses).toBe(0);

      await expect(selected.handler({}, context({
        config: { [configName]: false },
        onDiscordAccess: touched,
      }))).resolves.toEqual({
        success: false,
        error: 'That Discord Admin capability is disabled in the plugin settings.',
      });
      expect(discordAccesses).toBe(0);
    },
  );
});

describe('Discord Admin member moderation', () => {
  it('sets a server nickname but refuses a member above the bot hierarchy', async () => {
    const setNickname = vi.fn().mockResolvedValue(undefined);
    const target = { id: USER_ID, manageable: true, setNickname };
    const me = botMember('ManageNicknames');
    const fetch = vi.fn().mockResolvedValue(target);
    const guild = { id: GUILD_ID, members: { me, fetch } };
    const args = {
      userId: USER_ID,
      nickname: '  New Name  ',
      reason: 'requested rename',
    };

    const completed = await requestAndConfirm('set_nickname', args, { guild });
    expect(completed.result).toEqual({
      success: true,
      userId: USER_ID,
      nickname: 'New Name',
    });
    expect(fetch).toHaveBeenCalledWith({ user: USER_ID, force: true });
    expect(setNickname).toHaveBeenCalledWith(
      'New Name',
      `Big Yahu controller ${REQUESTER_ID}: requested rename`,
    );

    const blockedSetNickname = vi.fn();
    fetch.mockResolvedValue({ id: SECOND_USER_ID, manageable: false, setNickname: blockedSetNickname });
    const blocked = await requestAndConfirm('set_nickname', {
      userId: SECOND_USER_ID,
      nickname: 'Nope',
      reason: 'hierarchy check',
    }, { guild });
    expect(blocked.result).toEqual({
      success: false,
      error: 'That member is at or above the bot in the role hierarchy.',
    });
    expect(blockedSetNickname).not.toHaveBeenCalled();
  });

  it('binds confirmation to canonical payload values including the normalized, capped audit reason', async () => {
    const original = { userId: USER_ID, nickname: 'Alpha', reason: 'first reason' };
    const phrase = await requestConfirmation('set_nickname', original);
    const normalizedReasonPhrase = await requestConfirmation('set_nickname', {
      ...original,
      reason: '  first reason  ',
    });
    expect(normalizedReasonPhrase).toBe(phrase);

    const changedReasonPhrase = await requestConfirmation('set_nickname', {
      ...original,
      reason: 'a different audit reason',
    });
    expect(changedReasonPhrase).not.toBe(phrase);

    const cappedReasonPhrase = await requestConfirmation('set_nickname', {
      ...original,
      reason: `${'x'.repeat(511)}a`,
    });
    const sameCappedReasonPhrase = await requestConfirmation('set_nickname', {
      ...original,
      reason: `${'x'.repeat(511)}b`,
    });
    expect(sameCappedReasonPhrase).toBe(cappedReasonPhrase);

    const changed = await tool('set_nickname').handler({
      ...original,
      nickname: 'Beta',
    }, context({ requestContent: phrase }));
    const changedPhrase = confirmationPhrase(changed);
    expect(changedPhrase).not.toBe(phrase);
    expect(changedPhrase).toMatch(new RegExp(`^CONFIRM SET NICKNAME ${USER_ID} `));
  });

  it('requires the exact fresh confirmation for kick, ban and role deletion before a guild lookup', async () => {
    const cases = [
      ['kick_member', { userId: USER_ID, reason: 'kick' }, `CONFIRM KICK ${USER_ID} `],
      ['ban_member', { userId: USER_ID, reason: 'ban' }, `CONFIRM BAN ${USER_ID} `],
      ['delete_role', { roleId: ROLE_ID, reason: 'delete' }, `CONFIRM DELETE ROLE ${ROLE_ID} `],
    ] as const;

    for (const [name, args, prefix] of cases) {
      let guildAccesses = 0;
      const options = {
        config: { requireMutationConfirmation: false },
        onGuildAccess: () => { guildAccesses += 1; },
      };
      const phrase = await requestConfirmation(name, args, options);
      expect(phrase.startsWith(prefix)).toBe(true);

      await expect(tool(name).handler(args, context({
        ...options,
        requestContent: `please ${phrase} now`,
      }))).resolves.toMatchObject({
        success: false,
        confirmationRequired: phrase,
      });
      expect(guildAccesses, name).toBe(0);
    }
  });

  it('does not let a zero-deletion confirmation authorize a ban that deletes messages', async () => {
    let guildAccesses = 0;
    const seconds = 3_600;
    const options = {
      config: { requireMutationConfirmation: false },
      onGuildAccess: () => { guildAccesses += 1; },
    };
    const zeroDeletionArgs = { userId: USER_ID, reason: 'ban and delete messages' };
    const zeroDeletionPhrase = await requestConfirmation('ban_member', zeroDeletionArgs, options);

    const changed = await tool('ban_member').handler({
      userId: USER_ID,
      deleteMessageSeconds: seconds,
      reason: 'ban and delete messages',
    }, context({
      ...options,
      requestContent: zeroDeletionPhrase,
    }));
    const changedPhrase = confirmationPhrase(changed);
    expect(changedPhrase).not.toBe(zeroDeletionPhrase);
    expect(changedPhrase).toMatch(new RegExp(
      `^CONFIRM BAN ${USER_ID} DELETE ${seconds} SECONDS [A-F0-9]{24}$`,
    ));
    expect(guildAccesses).toBe(0);
  });

  it('performs kick, ban and role deletion after their exact confirmations', async () => {
    const kick = vi.fn().mockResolvedValue(undefined);
    const kickTarget = { id: USER_ID, kickable: true, kick };
    const banTarget = { id: SECOND_USER_ID, bannable: true };
    const ban = vi.fn().mockResolvedValue(undefined);
    const deletedRole = {
      id: ROLE_ID,
      name: 'Temporary',
      editable: true,
      permissions: permissions(),
    };
    const deleteRole = vi.fn().mockResolvedValue(undefined);
    const fetchMember = vi.fn(async ({ user }: { user: string }) => (
      user === USER_ID ? kickTarget : banTarget
    ));
    const me = botMember('BanMembers', 'ManageRoles');
    const guild = {
      id: GUILD_ID,
      members: { me, fetch: fetchMember, ban },
      roles: { fetch: vi.fn().mockResolvedValue(deletedRole), delete: deleteRole },
    };
    const criticalConfig = { requireMutationConfirmation: false };
    const kicked = await requestAndConfirm(
      'kick_member',
      { userId: USER_ID, reason: 'confirmed kick' },
      { guild, config: criticalConfig },
    );
    expect(kicked.result).toMatchObject({ success: true, kicked: USER_ID });

    const banArgs = { userId: SECOND_USER_ID, reason: 'confirmed ban' };
    const banPhrase = await requestConfirmation('ban_member', banArgs, { guild, config: criticalConfig });
    await expect(tool('ban_member').handler(banArgs, context({
      guild,
      config: criticalConfig,
      requestContent: `<@!${BOT_ID}> ${banPhrase}`,
    }))).resolves.toMatchObject({ success: true, banned: SECOND_USER_ID });

    const deleted = await requestAndConfirm(
      'delete_role',
      { roleId: ROLE_ID, reason: 'confirmed delete' },
      { guild, config: criticalConfig },
    );
    expect(deleted.result).toMatchObject({ success: true, deletedRoleId: ROLE_ID });

    expect(kick).toHaveBeenCalledOnce();
    expect(ban).toHaveBeenCalledWith(SECOND_USER_ID, expect.objectContaining({
      deleteMessageSeconds: 0,
      reason: `Big Yahu controller ${REQUESTER_ID}: confirmed ban`,
    }));
    expect(deleteRole).toHaveBeenCalledWith(
      deletedRole,
      `Big Yahu controller ${REQUESTER_ID}: confirmed delete`,
    );
  });

  it('confirms unban and role creation by default but lets ordinary mutations opt out', async () => {
    const unban = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({
      id: ROLE_ID,
      name: 'New Role',
      permissions: permissions('ViewChannel'),
    });
    const guild = {
      id: GUILD_ID,
      members: {
        me: botMember('BanMembers', 'ManageRoles', 'ViewChannel'),
        unban,
      },
      roles: { create },
    };
    const unbanArgs = { userId: USER_ID, reason: 'allow back in' };
    const roleArgs = {
      name: 'New Role',
      permissions: ['ViewChannel'],
      reason: 'create a role',
    };

    const unbanned = await requestAndConfirm('unban_member', unbanArgs, { guild });
    expect(unbanned.result).toMatchObject({ success: true, unbanned: USER_ID });
    const created = await requestAndConfirm('create_role', roleArgs, { guild });
    expect(created.result).toMatchObject({ success: true, roleId: ROLE_ID });
    expect(unban).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();

    await expect(tool('unban_member').handler(unbanArgs, context({
      guild,
      config: { requireMutationConfirmation: false },
    }))).resolves.toMatchObject({ success: true, unbanned: USER_ID });
    expect(unban).toHaveBeenCalledTimes(2);
  });

  it('rejects timeouts outside 0..40320 before Discord access and accepts both bounds', async () => {
    for (const minutes of [-1, 40_321, 1.5]) {
      let discordAccesses = 0;
      await expect(tool('timeout_member').handler({
        userId: USER_ID,
        minutes,
        reason: 'timeout',
      }, context({ onDiscordAccess: () => { discordAccesses += 1; } }))).resolves.toEqual({
        success: false,
        error: 'minutes must be a whole number from 0 to 40320.',
      });
      expect(discordAccesses).toBe(0);
    }

    const timeoutUntil = new Date('2042-03-04T05:06:07.000Z');
    const timeout = vi.fn()
      .mockResolvedValueOnce({ communicationDisabledUntil: null })
      .mockResolvedValueOnce({ communicationDisabledUntil: timeoutUntil });
    const member = { id: USER_ID, moderatable: true, timeout };
    const guild = {
      id: GUILD_ID,
      members: {
        me: botMember('ModerateMembers'),
        fetch: vi.fn().mockResolvedValue(member),
      },
    };
    const removed = await requestAndConfirm('timeout_member', {
      userId: USER_ID,
      minutes: 0,
      reason: 'remove timeout',
    }, { guild });
    expect(removed.result).toMatchObject({
      success: true,
      timeoutMinutes: 0,
      communicationDisabledUntil: null,
    });
    const maximum = await requestAndConfirm('timeout_member', {
      userId: USER_ID,
      minutes: 40_320,
      reason: 'maximum timeout',
    }, { guild });
    expect(maximum.result).toMatchObject({
      success: true,
      timeoutMinutes: 40_320,
      communicationDisabledUntil: timeoutUntil.toISOString(),
    });
    expect(timeout).toHaveBeenNthCalledWith(
      1,
      null,
      `Big Yahu controller ${REQUESTER_ID}: remove timeout`,
    );
    expect(timeout).toHaveBeenNthCalledWith(
      2,
      40_320 * 60_000,
      `Big Yahu controller ${REQUESTER_ID}: maximum timeout`,
    );
  });

  it('adds one role without replacing a member\'s other roles', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn();
    const member = { id: USER_ID, manageable: true, roles: { add, remove } };
    const role = {
      id: ROLE_ID,
      name: 'Helper',
      editable: true,
      permissions: permissions('ViewChannel'),
    };
    const guild = {
      id: GUILD_ID,
      members: { me: botMember('ManageRoles'), fetch: vi.fn().mockResolvedValue(member) },
      roles: { fetch: vi.fn().mockResolvedValue(role) },
    };

    const completed = await requestAndConfirm('set_member_role', {
      action: 'add',
      userId: USER_ID,
      roleId: ROLE_ID,
      reason: 'promote helper',
    }, { guild });
    expect(completed.result).toEqual({
      success: true,
      action: 'add',
      userId: USER_ID,
      roleId: ROLE_ID,
      roleName: 'Helper',
    });
    expect(add).toHaveBeenCalledWith(
      role,
      `Big Yahu controller ${REQUESTER_ID}: promote helper`,
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps Administrator assignment behind its setting and confirmation', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const member = { id: USER_ID, manageable: true, roles: { add, remove: vi.fn() } };
    const adminRole = {
      id: ROLE_ID,
      name: 'Administrator',
      editable: true,
      permissions: permissions('Administrator'),
    };
    const guild = {
      id: GUILD_ID,
      members: { me: botMember('Administrator'), fetch: vi.fn().mockResolvedValue(member) },
      roles: { fetch: vi.fn().mockResolvedValue(adminRole) },
    };
    const args = { action: 'add', userId: USER_ID, roleId: ROLE_ID, reason: 'full access' };

    await expect(tool('set_member_role').handler(args, context({
      guild,
      config: { allowAdministratorPermission: false },
    }))).resolves.toEqual({
      success: false,
      error: 'Assigning an Administrator role is disabled in the plugin settings.',
    });
    expect(add).not.toHaveBeenCalled();

    const completed = await requestAndConfirm('set_member_role', args, {
      guild,
      config: {
        allowAdministratorPermission: true,
        requireMutationConfirmation: false,
      },
    });
    expect(completed.phrase).toMatch(new RegExp(
      `^CONFIRM ADD ADMINISTRATOR ROLE ${ROLE_ID} TO ${USER_ID} [A-F0-9]{24}$`,
    ));
    expect(completed.result).toMatchObject({ success: true, action: 'add' });
    expect(add).toHaveBeenCalledOnce();
  });

  it('uses effective Move Members and Connect permissions in both voice channels', async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const member = {
      id: USER_ID,
      manageable: true,
      voice: { channelId: SOURCE_VOICE_CHANNEL_ID as string | null },
      edit,
    };
    const fetchMember = vi.fn().mockResolvedValue(member);
    const destination = { id: CHANNEL_ID, isVoiceBased: () => true };
    const source = { id: SOURCE_VOICE_CHANNEL_ID, isVoiceBased: () => true };
    let destinationPermissions = permissions('ViewChannel');
    let sourcePermissions = permissions();
    const permissionsIn = vi.fn((channel: { id: string }) => (
      channel.id === CHANNEL_ID ? destinationPermissions : sourcePermissions
    ));
    const me = { ...botMember(), permissionsIn };
    const guild = {
      id: GUILD_ID,
      members: { me, fetch: fetchMember },
      channels: {
        fetch: vi.fn(async (id: string) => (id === CHANNEL_ID ? destination : source)),
      },
    };
    const args = { userId: USER_ID, channelId: CHANNEL_ID, reason: 'move voice member' };

    await expect(tool('set_voice_state').handler(args, context({ guild }))).resolves.toEqual({
      success: false,
      error: 'The bot needs Connect in the destination voice channel.',
    });
    expect(fetchMember).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();

    destinationPermissions = permissions('Connect');
    await expect(tool('set_voice_state').handler(args, context({ guild }))).resolves.toEqual({
      success: false,
      error: 'The bot needs Move Members in the destination voice channel.',
    });
    expect(fetchMember).not.toHaveBeenCalled();

    destinationPermissions = permissions('Connect', 'MoveMembers');
    await expect(tool('set_voice_state').handler(args, context({ guild }))).resolves.toEqual({
      success: false,
      error: 'The bot needs Move Members in the member\'s current voice channel.',
    });
    expect(edit).not.toHaveBeenCalled();

    sourcePermissions = permissions('MoveMembers');
    const completed = await requestAndConfirm('set_voice_state', args, { guild });
    expect(completed.result).toMatchObject({
      success: true,
      userId: USER_ID,
      channelId: CHANNEL_ID,
    });
    expect(edit).toHaveBeenCalledWith({
      channel: CHANNEL_ID,
      reason: `Big Yahu controller ${REQUESTER_ID}: move voice member`,
    });

    member.voice.channelId = null;
    await expect(tool('set_voice_state').handler(args, context({ guild }))).resolves.toEqual({
      success: false,
      error: 'That member is not connected to a voice channel.',
    });
    expect(edit).toHaveBeenCalledOnce();
  });
});

describe('Discord Admin inspection', () => {
  it('treats an empty or whitespace-only query as no filter', async () => {
    const role = {
      id: ROLE_ID,
      name: 'Everyone useful',
      position: 2,
      managed: false,
      editable: true,
      hoist: false,
      mentionable: false,
      hexColor: '#000000',
      permissions: permissions('ViewChannel'),
    };
    const fetchRoles = vi.fn().mockResolvedValue(new Map([[ROLE_ID, role]]));
    const guild = {
      id: GUILD_ID,
      members: { me: botMember('ViewChannel') },
      roles: { fetch: fetchRoles },
    };

    await expect(tool('inspect_discord').handler({
      scope: 'roles',
      query: '   ',
    }, context({ guild }))).resolves.toMatchObject({
      success: true,
      total: 1,
      roles: [{ id: ROLE_ID, name: 'Everyone useful' }],
    });
    expect(fetchRoles).toHaveBeenCalledOnce();
  });

  it('fetches an exact ban by user id and treats Discord unknown-ban as an empty result', async () => {
    const ban = {
      user: { id: USER_ID, username: 'banned-user' },
      reason: 'spam',
    };
    const fetchBan = vi.fn(async (userId: string) => {
      if (userId === USER_ID) return ban;
      throw Object.assign(new Error('Unknown Ban'), { code: '10026' });
    });
    const guild = {
      id: GUILD_ID,
      members: { me: botMember('BanMembers') },
      bans: { fetch: fetchBan },
    };

    await expect(tool('inspect_discord').handler({
      scope: 'bans',
      query: USER_ID,
    }, context({ guild }))).resolves.toEqual({
      success: true,
      total: 1,
      bans: [{ userId: USER_ID, username: 'banned-user', reason: 'spam' }],
    });
    await expect(tool('inspect_discord').handler({
      scope: 'bans',
      query: SECOND_USER_ID,
    }, context({ guild }))).resolves.toEqual({ success: true, total: 0, bans: [] });
    expect(fetchBan.mock.calls).toEqual([[USER_ID], [SECOND_USER_ID]]);
  });
});

describe('Discord Admin permission mutation', () => {
  it('names @everyone explicitly when confirming an Administrator grant', async () => {
    const role = {
      id: GUILD_ID,
      name: '@everyone',
      editable: true,
      permissions: permissions(),
    };
    const edit = vi.fn();
    const guild = {
      id: GUILD_ID,
      members: { me: botMember('Administrator') },
      roles: { fetch: vi.fn().mockResolvedValue(role), edit },
    };
    const args = {
      roleId: GUILD_ID,
      grantPermissions: ['Administrator'],
      reason: 'make everyone administrator',
    };

    const phrase = await requestConfirmation('edit_role', args, {
      guild,
      config: {
        allowAdministratorPermission: true,
        requireMutationConfirmation: false,
      },
    });
    expect(phrase).toMatch(new RegExp(
      `^CONFIRM GRANT ADMINISTRATOR TO EVERYONE ${GUILD_ID} [A-F0-9]{24}$`,
    ));
    expect(edit).not.toHaveBeenCalled();
  });

  it('read-modify-writes role permissions without erasing unrelated bits', async () => {
    const futurePermissionBit = 1n << 62n;
    const originalBits = PermissionFlagsBits.ViewChannel
      | PermissionFlagsBits.SendMessages
      | PermissionFlagsBits.AttachFiles
      | futurePermissionBit;
    const role = {
      id: ROLE_ID,
      name: 'Writers',
      editable: true,
      permissions: new PermissionsBitField(originalBits),
    };
    const edit = vi.fn(async (_role: unknown, options: { permissions?: PermissionsBitField }) => ({
      ...role,
      permissions: options.permissions ?? role.permissions,
    }));
    const guild = {
      id: GUILD_ID,
      members: { me: botMember('ManageRoles', 'ManageMessages') },
      roles: { fetch: vi.fn().mockResolvedValue(role), edit },
    };

    const completed = await requestAndConfirm('edit_role', {
      roleId: ROLE_ID,
      grantPermissions: ['manage_messages'],
      revokePermissions: ['SEND-MESSAGES'],
      reason: 'adjust moderation',
    }, { guild });
    expect(completed.result).toMatchObject({ success: true, roleId: ROLE_ID });

    const options = edit.mock.calls[0]?.[1];
    const updatedPermissions = options?.permissions;
    expect(updatedPermissions).toBeInstanceOf(PermissionsBitField);
    if (!updatedPermissions) throw new Error('edit_role did not supply updated permissions');
    expect(updatedPermissions.bitfield).toBe(
      (originalBits | PermissionFlagsBits.ManageMessages) & ~PermissionFlagsBits.SendMessages,
    );
    expect(updatedPermissions.bitfield & futurePermissionBit).toBe(futurePermissionBit);
  });

  it('maps channel allow, deny and inherit states and confirms overwrite deletion', async () => {
    const editOverwrite = vi.fn().mockResolvedValue(undefined);
    const deleteOverwrite = vi.fn().mockResolvedValue(undefined);
    const channel = {
      id: CHANNEL_ID,
      isThread: () => false,
      permissionOverwrites: { edit: editOverwrite, delete: deleteOverwrite },
    };
    const role = { id: ROLE_ID, name: 'Readers', editable: false };
    const me = {
      ...botMember('ManageRoles'),
      permissionsIn: vi.fn(() => permissions('ManageRoles', 'ViewChannel', 'SendMessages')),
    };
    const fetchChannel = vi.fn().mockResolvedValue(channel);
    const guild = {
      id: GUILD_ID,
      members: { me },
      roles: { fetch: vi.fn().mockResolvedValue(role) },
      channels: { fetch: fetchChannel },
    };

    const editArgs = {
      action: 'edit',
      channelId: CHANNEL_ID,
      targetType: 'role',
      targetId: ROLE_ID,
      allow: ['view_channel'],
      deny: ['SEND-MESSAGES'],
      inherit: ['attach files'],
      reason: 'channel policy',
    };
    const edited = await requestAndConfirm('set_channel_permissions', editArgs, { guild });
    expect(edited.result).toEqual({
      success: true,
      channelId: CHANNEL_ID,
      targetId: ROLE_ID,
      targetType: 'role',
      allow: ['ViewChannel'],
      deny: ['SendMessages'],
      inherit: ['AttachFiles'],
    });
    expect(editOverwrite).toHaveBeenCalledWith(
      ROLE_ID,
      { ViewChannel: true, SendMessages: false, AttachFiles: null },
      {
        type: OverwriteType.Role,
        reason: `Big Yahu controller ${REQUESTER_ID}: channel policy`,
      },
    );

    const deleteArgs = {
      action: 'delete',
      channelId: CHANNEL_ID,
      targetType: 'role',
      targetId: ROLE_ID,
      reason: 'remove override',
    };
    const deleted = await requestAndConfirm('set_channel_permissions', deleteArgs, {
      guild,
      config: { requireMutationConfirmation: false },
    });
    expect(deleted.phrase).toMatch(new RegExp(
      `^CONFIRM DELETE ROLE OVERWRITE ${ROLE_ID} IN ${CHANNEL_ID} [A-F0-9]{24}$`,
    ));
    expect(deleted.result).toMatchObject({ success: true, deleted: true });
    expect(deleteOverwrite).toHaveBeenCalledWith(
      ROLE_ID,
      `Big Yahu controller ${REQUESTER_ID}: remove override`,
    );
  });
});

describe('Discord Admin input validation', () => {
  it.each(['not-an-id', '1234', '00000', '18446744073709551616'])(
    'rejects invalid Discord snowflake %s before Discord access',
    async (userId) => {
      let discordAccesses = 0;
      await expect(tool('set_nickname').handler({
        userId,
        nickname: 'Name',
        reason: 'rename',
      }, context({ onDiscordAccess: () => { discordAccesses += 1; } }))).resolves.toEqual({
        success: false,
        error: 'userId must be a Discord id.',
      });
      expect(discordAccesses).toBe(0);
    },
  );

  it('rejects unknown permission names before Discord access', async () => {
    let discordAccesses = 0;
    await expect(tool('create_role').handler({
      name: 'Broken',
      permissions: ['ManageRoles', 'DefinitelyNotAPermission'],
      reason: 'test validation',
    }, context({ onDiscordAccess: () => { discordAccesses += 1; } }))).resolves.toEqual({
      success: false,
      error: 'Unknown permissions: DefinitelyNotAPermission.',
    });
    expect(discordAccesses).toBe(0);
  });

  it('caps the URL-encoded audit reason and rejects more than 512 supplied characters', () => {
    const prefix = `Big Yahu controller ${REQUESTER_ID}: `;
    const supplied = 'č'.repeat(512);
    const fitted = auditReason(context(), supplied);

    expect(fitted.startsWith(prefix)).toBe(true);
    expect(encodeURIComponent(fitted).length).toBeLessThanOrEqual(512);
    expect(fitted).not.toBe(prefix + supplied);
    expect(() => auditReason(context(), 'x'.repeat(513)))
      .toThrow('reason must be at most 512 characters.');
  });
});


describe('moderating on its own judgement', () => {
  function guildWith(target: Record<string, unknown>) {
    return {
      id: GUILD_ID,
      ownerId: '900000000000000001',
      members: {
        me: botMember('KickMembers', 'ModerateMembers'),
        fetch: vi.fn(async () => target),
      },
    };
  }

  const kickable = () => ({
    id: USER_ID,
    kickable: true,
    moderatable: true,
    kick: vi.fn(async () => undefined),
    timeout: vi.fn(async () => ({ communicationDisabledUntil: new Date(1) })),
  });

  const ON = { autonomousModeration: true } as Partial<DiscordAdminConfig>;

  it('refuses a non-controller while the switch is off', async () => {
    await expect(tool('kick_member').handler(
      { userId: USER_ID, reason: 'they were rude' },
      context({ controller: false, guild: guildWith(kickable()) }),
    )).resolves.toMatchObject({
      success: false,
      error: 'Discord administration is restricted to configured Big Yahu controllers.',
    });
  });

  it('acts for anyone once the switch is on, without asking who they are', async () => {
    await expect(tool('timeout_member').handler(
      { userId: USER_ID, minutes: 10, reason: 'flooding the channel' },
      context({ controller: false, config: ON, guild: guildWith(kickable()) }),
    )).resolves.toMatchObject({ success: true, userId: USER_ID, timeoutMinutes: 10 });
  });

  it('needs no confirmation at all, even for a kick', async () => {
    // Nobody is there to send a phrase back when the bot decided this itself.
    await expect(tool('kick_member').handler(
      { userId: USER_ID, reason: 'came back and kept spamming' },
      context({ controller: false, config: ON, guild: guildWith(kickable()), requestContent: 'nothing like a confirmation' }),
    )).resolves.toMatchObject({ success: true, kicked: USER_ID });
  });

  it('still obeys the per-capability switches', async () => {
    await expect(tool('kick_member').handler(
      { userId: USER_ID, reason: 'spam' },
      context({ controller: false, config: { ...ON, enableKicks: false }, guild: guildWith(kickable()) }),
    )).resolves.toMatchObject({
      success: false,
      error: 'That Discord Admin capability is disabled in the plugin settings.',
    });
  });

  it('does not record a controller in the audit log for its own decision', () => {
    const own = auditReason(context({ controller: false, config: ON }), 'flooding');
    expect(own).toContain('Big Yahu, prompted by');
    expect(own).not.toContain('Big Yahu controller');
    expect(auditReason(context(), 'flooding')).toContain('Big Yahu controller');
  });

  it('leaves confirmation exactly as it was for a controller', async () => {
    const result = await tool('kick_member').handler(
      { userId: USER_ID, reason: 'spam' },
      context({ guild: guildWith(kickable()), requestContent: 'kick them' }),
    );
    expect(confirmationPhrase(result)).toMatch(/^CONFIRM KICK /);
  });
});

// The gates were never the problem here: with autonomous moderation on, both
// stand down and the tools are offered. What refused was the prose, and a rule
// that can never be satisfied is worse than no rule.
describe('what autonomous moderation actually tells the model', () => {
  const told = (over: Partial<typeof DEFAULT_CONFIG> = {}): string => {
    const config = { ...DEFAULT_CONFIG, ...over };
    return typeof discordAdminPlugin.instructions === 'function'
      ? discordAdminPlugin.instructions({ getConfig: () => config } as never)
      : String(discordAdminPlugin.instructions ?? '');
  };

  it('stops requiring a controller once the bot moderates on its own', () => {
    const autonomous = told({ autonomousModeration: true });
    // With nobody configured as a controller this could never be satisfied, so
    // the bot correctly refused everybody, including the people who run it.
    expect(autonomous).not.toContain("the controller's current message");
    expect(autonomous).toMatch(/anyone can ask/i);
  });

  it('keeps the controller gate word for word when it is switched off', () => {
    const gated = told({ autonomousModeration: false });
    expect(gated).toContain("the controller's current message");
    expect(gated).toMatch(/only while replying to a configured Big Yahu controller/i);
  });

  it('makes a controller weight rather than a gate', () => {
    expect(told({ autonomousModeration: true })).toMatch(/lean towards yes, not the only way to get a yes/i);
  });

  it('still says what must not be done on somebody else’s say-so', () => {
    const autonomous = told({ autonomousModeration: true });
    expect(autonomous).toMatch(/real\s+disadvantage for no reason/i);
    expect(autonomous).toMatch(/not banter/i);
    expect(autonomous).toMatch(/never touch anyone for disagreeing/i);
    // A stored fact is a fact, not somebody asking.
    expect(autonomous).toMatch(/is a fact, not a request/i);
  });
});
