import { createHash } from 'node:crypto';
import {
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type GuildMember,
  type PermissionsString,
} from 'discord.js';
import type { PluginTool, PluginToolContext } from '@big-yahu/plugin-sdk';
import { withDefaults, type DiscordAdminFeature } from './config';

const MAX_SNOWFLAKE = (1n << 64n) - 1n;

export const PERMISSION_NAMES = Object.freeze(Object.keys(PermissionFlagsBits) as PermissionsString[]);

const PERMISSIONS_BY_NORMALISED_NAME = new Map(
  PERMISSION_NAMES.map((name) => [normalisePermissionName(name), name]),
);

/** Accept `ManageRoles`, `MANAGE_ROLES` or `manage-roles`, but return the discord.js name. */
function normalisePermissionName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function snowflake(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{5,20}$/.test(value)) {
    throw new Error(`${label} must be a Discord id.`);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > MAX_SNOWFLAKE) throw new Error(`${label} must be a Discord id.`);
  return value;
}

export function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const text = value.trim();
  if (!text) throw new Error(`${label} cannot be empty.`);
  if ([...text].length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters.`);
  return text;
}

export function requiredText(value: unknown, label: string, maxLength: number): string {
  const text = optionalText(value, label, maxLength);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

export function booleanValue(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

export function permissionNames(value: unknown, label: string): PermissionsString[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of permission names.`);

  const names: PermissionsString[] = [];
  const unknown: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      unknown.push(String(entry));
      continue;
    }
    const resolved = PERMISSIONS_BY_NORMALISED_NAME.get(normalisePermissionName(entry));
    if (!resolved) unknown.push(entry);
    else if (!names.includes(resolved)) names.push(resolved);
  }
  if (unknown.length > 0) throw new Error(`Unknown ${label}: ${unknown.join(', ')}.`);
  return names;
}

export function permissionSummary(bitfield: Readonly<PermissionsBitField>): {
  bitfield: string;
  names: PermissionsString[];
} {
  return { bitfield: bitfield.bitfield.toString(), names: bitfield.toArray() };
}

export function permissionCatalogue(): Array<{ name: PermissionsString; bit: string }> {
  return PERMISSION_NAMES.map((name) => ({ name, bit: PermissionFlagsBits[name].toString() }));
}

export function accessDenied(
  ctx: PluginToolContext,
  feature: DiscordAdminFeature,
): { success: false; error: string } | null {
  if (!ctx.invocation.requesterIsController) {
    return { success: false, error: 'Discord administration is restricted to configured Big Yahu controllers.' };
  }
  if (!withDefaults(ctx.getConfig())[feature]) {
    return { success: false, error: 'That Discord Admin capability is disabled in the plugin settings.' };
  }
  return null;
}

/** Only ever returns the guild which produced this tool invocation. Model arguments cannot select another one. */
export function invocationGuild(ctx: PluginToolContext): Guild {
  if (!ctx.discordClient) throw new Error('The Discord bot is offline.');
  const guild = ctx.discordClient.guilds.cache.get(ctx.invocation.guildId);
  if (!guild) throw new Error('The Discord server for this request is no longer available.');
  return guild;
}

export async function botMember(guild: Guild): Promise<GuildMember> {
  return guild.members.me ?? guild.members.fetchMe({ force: true });
}

export function requirePermission(member: GuildMember, permission: PermissionsString, label?: string): void {
  if (!member.permissions.has(PermissionFlagsBits[permission])) {
    throw new Error(`The bot needs the ${label ?? permission} permission for that.`);
  }
}

export function requirePermissions(member: GuildMember, permissions: PermissionsString[]): void {
  const missing = permissions.filter((name) => !member.permissions.has(PermissionFlagsBits[name]));
  if (missing.length > 0) {
    throw new Error(`The bot cannot grant permissions it does not have: ${missing.join(', ')}.`);
  }
}

/** discord.js accepts the raw reason and URL-encodes it. Keep that encoded header within Discord's 512 limit. */
export function auditReason(ctx: PluginToolContext, supplied: unknown): string {
  const reason = requiredText(supplied, 'reason', 512);
  const source = `Big Yahu controller ${ctx.invocation.requesterId}: ${reason}`;
  let fitted = '';
  for (const character of source) {
    if (encodeURIComponent(fitted + character).length > 512) break;
    fitted += character;
  }
  return fitted;
}

function normaliseConfirmation(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function confirmationRequired(
  ctx: PluginToolContext,
  phrase: string,
  always = false,
): { success: false; error: string; confirmationRequired: string } | null {
  const config = withDefaults(ctx.getConfig());
  if (!always && !config.requireMutationConfirmation) return null;
  const botId = ctx.discordClient?.user?.id;
  const contentWithoutBotMention = botId
    ? ctx.invocation.requestContent
        .replaceAll(`<@${botId}>`, ' ')
        .replaceAll(`<@!${botId}>`, ' ')
    : ctx.invocation.requestContent;
  if (normaliseConfirmation(contentWithoutBotMention) === normaliseConfirmation(phrase)) return null;
  return {
    success: false,
    error: `This action was not confirmed in the controller's message. Ask them to send exactly: ${phrase}`,
    confirmationRequired: phrase,
  };
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalise)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalise(entry)]),
    );
  }
  return value;
}

/** Exact confirmation whose digest changes whenever a security-relevant argument changes. */
export function mutationConfirmationRequired(
  ctx: PluginToolContext,
  action: string,
  payload: Record<string, unknown>,
  always = false,
): { success: false; error: string; confirmationRequired: string } | null {
  const canonical = JSON.stringify(canonicalise({ action, payload }));
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 24).toUpperCase();
  return confirmationRequired(ctx, `CONFIRM ${action} ${digest}`, always);
}

export function safeError(error: unknown): { success: false; error: string; discordCode?: string | number } {
  const candidate = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const code = typeof candidate.code === 'string' || typeof candidate.code === 'number' ? candidate.code : undefined;
  const message = error instanceof Error ? error.message : 'Discord rejected the operation.';
  return {
    success: false,
    error: message.slice(0, 300),
    ...(code === undefined ? {} : { discordCode: code }),
  };
}

export function guarded(
  feature: DiscordAdminFeature,
  operation: PluginTool['handler'],
): PluginTool['handler'] {
  return async (args, ctx) => {
    const denied = accessDenied(ctx, feature);
    if (denied) return denied;
    try {
      return await operation(args, ctx);
    } catch (error) {
      return safeError(error);
    }
  };
}

export function isUnknownMember(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 10007 || code === '10007';
}

export function isUnknownBan(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 10026 || code === '10026';
}

const queues = new Map<string, Promise<void>>();

/** Serialize read-modify-write permission updates aimed at the same role or overwrite. */
export async function serialise<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => turn);
  queues.set(key, tail);

  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
