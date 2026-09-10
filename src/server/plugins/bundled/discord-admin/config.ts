export interface DiscordAdminConfig {
  enableInspection: boolean;
  enableNicknames: boolean;
  enableTimeouts: boolean;
  enableKicks: boolean;
  enableBans: boolean;
  enableMemberRoles: boolean;
  enableRoleManagement: boolean;
  enableChannelPermissions: boolean;
  enableVoiceModeration: boolean;
  allowAdministratorPermission: boolean;
  requireMutationConfirmation: boolean;
}

export type DiscordAdminFeature = Exclude<
  keyof DiscordAdminConfig,
  'allowAdministratorPermission' | 'requireMutationConfirmation'
>;

export const DEFAULT_CONFIG: DiscordAdminConfig = {
  enableInspection: true,
  enableNicknames: true,
  enableTimeouts: true,
  enableKicks: true,
  enableBans: true,
  enableMemberRoles: true,
  enableRoleManagement: true,
  enableChannelPermissions: true,
  enableVoiceModeration: true,
  // Administrator bypasses every channel overwrite. It stays behind its own
  // opt-in even after the plugin itself and role management have been enabled.
  allowAdministratorPermission: false,
  // Ordinary mutations require an exact, payload-bound confirmation phrase by
  // default. Irreversible actions and Administrator grants always require one.
  requireMutationConfirmation: true,
};

/** Saved config predates new fields after an update, so defaults are merged every time it is read. */
export function withDefaults(config: Partial<DiscordAdminConfig>): DiscordAdminConfig {
  const boolean = (key: keyof DiscordAdminConfig): boolean =>
    typeof config[key] === 'boolean' ? config[key] : DEFAULT_CONFIG[key];

  return {
    enableInspection: boolean('enableInspection'),
    enableNicknames: boolean('enableNicknames'),
    enableTimeouts: boolean('enableTimeouts'),
    enableKicks: boolean('enableKicks'),
    enableBans: boolean('enableBans'),
    enableMemberRoles: boolean('enableMemberRoles'),
    enableRoleManagement: boolean('enableRoleManagement'),
    enableChannelPermissions: boolean('enableChannelPermissions'),
    enableVoiceModeration: boolean('enableVoiceModeration'),
    allowAdministratorPermission: boolean('allowAdministratorPermission'),
    requireMutationConfirmation: boolean('requireMutationConfirmation'),
  };
}
