export interface DiscordAdminConfig {
  enableInspection: boolean;
  enableAuditLog: boolean;
  /** How far back a single audit-log read may reach, in hours. */
  auditLogLookbackHours: number;
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
  autonomousModeration: boolean;
}

export type DiscordAdminFeature = Exclude<
  keyof DiscordAdminConfig,
  'allowAdministratorPermission' | 'requireMutationConfirmation' | 'autonomousModeration' | 'auditLogLookbackHours'
>;

export const DEFAULT_CONFIG: DiscordAdminConfig = {
  enableInspection: true,
  // On with the rest of them. The plugin as a whole is off until an operator
  // enables it, and once it is, reading a log is the least invasive thing here —
  // strictly less than the kicks and bans that default on beside it.
  enableAuditLog: true,
  auditLogLookbackHours: 24 * 7,
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
  // Off, so the plugin starts as controllers-only exactly as before. On, the
  // bot moderates on its own judgement — see the field description.
  autonomousModeration: false,
};

/** Saved config predates new fields after an update, so defaults are merged every time it is read. */
export function withDefaults(config: Partial<DiscordAdminConfig>): DiscordAdminConfig {
  const boolean = (key: DiscordAdminFeature | 'allowAdministratorPermission' | 'requireMutationConfirmation'
    | 'autonomousModeration'): boolean =>
    typeof config[key] === 'boolean' ? config[key] : DEFAULT_CONFIG[key];

  const whole = (key: 'auditLogLookbackHours', min: number, max: number): number => {
    const value = config[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONFIG[key];
    return Math.min(max, Math.max(min, Math.round(value)));
  };

  return {
    enableInspection: boolean('enableInspection'),
    enableAuditLog: boolean('enableAuditLog'),
    // Discord keeps 90 days of audit log, so asking for more is asking for all of it.
    auditLogLookbackHours: whole('auditLogLookbackHours', 1, 24 * 90),
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
    autonomousModeration: boolean('autonomousModeration'),
  };
}
