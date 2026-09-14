import { describe, expect, it, vi } from 'vitest';
import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import type { Client } from 'discord.js';
import type { PluginToolContext } from '@big-yahu/plugin-sdk';
import { auditLogTool } from '../../src/server/plugins/bundled/discord-admin/auditLogTool';
import { DEFAULT_CONFIG } from '../../src/server/plugins/bundled/discord-admin/config';

const GUILD_ID = '600000000000000001';
const BOT_ID = '900000000000000001';
const HOUR = 60 * 60 * 1000;

interface Entry {
  id: string;
  action: AuditLogEvent;
  createdTimestamp: number;
  executorId?: string | null;
  targetId?: string | null;
  reason?: string | null;
  changes?: Array<{ key: string; old?: unknown; new?: unknown }>;
}

const entry = (id: string, at: number, over: Partial<Entry> = {}): Entry => ({
  id,
  action: AuditLogEvent.MemberBanAdd,
  createdTimestamp: at,
  executorId: '111111111111111111',
  targetId: '222222222222222222',
  reason: null,
  changes: [],
  ...over,
});

function guildWith(entries: Entry[], options: { canView?: boolean } = {}) {
  const fetchAuditLogs = vi.fn(async ({ limit, type, user, before }: {
    limit: number; type?: AuditLogEvent; user?: string; before?: string;
  }) => {
    let rows = entries;
    if (type !== undefined) rows = rows.filter((row) => row.action === type);
    if (user !== undefined) rows = rows.filter((row) => row.executorId === user);
    if (before !== undefined) rows = rows.filter((row) => BigInt(row.id) < BigInt(before));
    return { entries: new Map(rows.slice(0, limit).map((row) => [row.id, row])) };
  });
  const permissions = { has: (flag: bigint) => options.canView === false ? false : flag === PermissionFlagsBits.ViewAuditLog };
  return {
    fetchAuditLogs,
    members: { fetchMe: async () => ({ permissions }) },
  };
}

function context(guild: unknown, config: Partial<typeof DEFAULT_CONFIG> = {}): PluginToolContext {
  const client = {
    user: { id: BOT_ID },
    guilds: { cache: { get: (id: string) => (id === GUILD_ID ? guild : undefined) } },
  } as unknown as Client;
  return {
    invocation: {
      guildId: GUILD_ID, channelId: 'c', messageId: 'm',
      requesterId: 'r', requesterIsController: true, requestContent: 'who banned them',
    },
    getConfig: () => ({ ...DEFAULT_CONFIG, ...config }),
    discordClient: client,
  } as unknown as PluginToolContext;
}

const run = (guild: unknown, args: Record<string, unknown> = {}, config: Partial<typeof DEFAULT_CONFIG> = {}) =>
  auditLogTool.handler(args, context(guild, config)) as Promise<Record<string, any>>;

describe('reading the audit log', () => {
  const now = Date.now();

  it('names people by mention, never by a name captured at the time', async () => {
    const guild = guildWith([entry('10', now - HOUR, { reason: 'spam' })]);
    const result = await run(guild);
    expect(result.entries[0]).toMatchObject({
      action: 'member_banned',
      by: '<@111111111111111111>',
      target: '<@222222222222222222>',
      reason: 'spam',
    });
  });

  it('stops at the configured look-back, and says the window is why', async () => {
    const guild = guildWith([entry('20', now - HOUR), entry('10', now - 500 * HOUR)]);
    const result = await run(guild, {}, { auditLogLookbackHours: 24 });
    expect(result.entries).toHaveLength(1);
    expect(result.lookbackHours).toBe(24);
  });

  // "Nothing" and "nothing in the last week" are different answers, and the
  // model has to be able to tell them apart when it replies.
  it('says an empty answer is about the window rather than all time', async () => {
    const result = await run(guildWith([entry('10', now - 500 * HOUR)]), {}, { auditLogLookbackHours: 24 });
    expect(result.entries).toEqual([]);
    expect(result.note).toContain('24 hours');
  });

  it('narrows to one kind of action, and refuses one nobody named', async () => {
    const guild = guildWith([
      entry('20', now - HOUR),
      entry('10', now - 2 * HOUR, { action: AuditLogEvent.MemberKick }),
    ]);
    expect((await run(guild, { action: 'member_kicked' })).entries).toHaveLength(1);
    expect((await run(guild, { action: 'invented' })).error).toContain('action must be one of');
  });

  it('narrows to what one person did', async () => {
    const guild = guildWith([
      entry('20', now - HOUR),
      entry('10', now - 2 * HOUR, { executorId: '333333333333333333' }),
    ]);
    const result = await run(guild, { userId: '333333333333333333' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].by).toBe('<@333333333333333333>');
  });

  it('holds the count inside its bounds', async () => {
    const guild = guildWith(Array.from({ length: 30 }, (_, index) => entry(String(100 - index), now - HOUR)));
    expect((await run(guild, { limit: 5 })).entries).toHaveLength(5);
    expect((await run(guild, { limit: 900 })).error).toContain('limit');
  });

  // Discord has the last word. Saying so is the honest answer; there is no way
  // around the permission and nothing to pretend about.
  it('reports Discord refusing rather than guessing at the answer', async () => {
    const result = await run(guildWith([entry('10', now - HOUR)], { canView: false }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('View Audit Log');
  });

  it('reports an event it has no name for rather than swallowing it', async () => {
    const guild = guildWith([entry('10', now - HOUR, { action: 12345 as AuditLogEvent })]);
    expect((await run(guild)).entries[0].action).toBe('action_12345');
  });
});

