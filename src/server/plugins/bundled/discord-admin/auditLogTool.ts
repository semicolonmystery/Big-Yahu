import { AuditLogEvent } from 'discord.js';
import type { GuildAuditLogsEntry } from 'discord.js';
import type { PluginTool } from '@big-yahu/plugin-sdk';
import { botMember, guarded, integer, invocationGuild, requirePermission, snowflake } from './support';
import { withDefaults, type DiscordAdminConfig } from './config';

/**
 * Reading Discord's own record of who did what.
 *
 * The bot is regularly asked things it has no way to answer from messages —
 * who banned somebody, who deleted the channel, whether a kick was a kick or a
 * leave. None of that is in the conversation, and guessing at it is exactly the
 * kind of confident invention the reply prompt spends paragraphs forbidding.
 *
 * It answers in Discord and nowhere else: no admin page, since Discord's own
 * audit-log view already exists and is better than anything here would be.
 *
 * Everything comes back as `<@id>` mentions rather than names. The reply
 * renders those into whatever people are called today, and a name captured here
 * would be whatever they were called at the time — which is either stale or a
 * different person.
 */

/** The events worth naming. Anything else is reported by its numeric action. */
const NAMED_EVENTS: Record<string, AuditLogEvent> = {
  member_kicked: AuditLogEvent.MemberKick,
  member_banned: AuditLogEvent.MemberBanAdd,
  member_unbanned: AuditLogEvent.MemberBanRemove,
  member_timed_out: AuditLogEvent.MemberUpdate,
  member_roles_changed: AuditLogEvent.MemberRoleUpdate,
  member_moved_in_voice: AuditLogEvent.MemberMove,
  member_disconnected: AuditLogEvent.MemberDisconnect,
  messages_deleted: AuditLogEvent.MessageDelete,
  messages_bulk_deleted: AuditLogEvent.MessageBulkDelete,
  message_pinned: AuditLogEvent.MessagePin,
  channel_created: AuditLogEvent.ChannelCreate,
  channel_updated: AuditLogEvent.ChannelUpdate,
  channel_deleted: AuditLogEvent.ChannelDelete,
  channel_permissions_changed: AuditLogEvent.ChannelOverwriteUpdate,
  role_created: AuditLogEvent.RoleCreate,
  role_updated: AuditLogEvent.RoleUpdate,
  role_deleted: AuditLogEvent.RoleDelete,
  invite_created: AuditLogEvent.InviteCreate,
  server_updated: AuditLogEvent.GuildUpdate,
};

const EVENT_NAMES = Object.keys(NAMED_EVENTS);
const NAME_BY_EVENT = new Map(Object.entries(NAMED_EVENTS).map(([name, event]) => [event, name]));

/** Discord's own per-request maximum. */
const PAGE = 100;
/** More than this in one answer is a log dump, not an answer to a question. */
const MAX_ENTRIES = 50;

function describeChanges(entry: GuildAuditLogsEntry): string[] {
  return entry.changes.slice(0, 8).map((change) => {
    const from = change.old === undefined ? '' : ` from ${JSON.stringify(change.old).slice(0, 80)}`;
    const to = change.new === undefined ? '' : ` to ${JSON.stringify(change.new).slice(0, 80)}`;
    return `${change.key}${from}${to}`;
  });
}

function view(entry: GuildAuditLogsEntry): Record<string, unknown> {
  const targetId = entry.targetId;
  return {
    id: entry.id,
    // Named where there is a name for it; the raw action otherwise, so an event
    // this list has never heard of is still reported rather than swallowed.
    action: NAME_BY_EVENT.get(entry.action) ?? `action_${String(entry.action)}`,
    at: new Date(entry.createdTimestamp).toISOString(),
    by: entry.executorId ? `<@${entry.executorId}>` : 'somebody Discord did not name',
    ...(targetId ? { target: `<@${targetId}>`, targetId } : {}),
    ...(entry.reason ? { reason: entry.reason.slice(0, 300) } : {}),
    ...(entry.changes.length > 0 ? { changed: describeChanges(entry) } : {}),
  };
}

export const auditLogTool: PluginTool = {
  requiresController: true,
  controllerBypassConfig: 'autonomousModeration',
  enabledByConfig: 'enableAuditLog',
  name: 'read_audit_log',
  description:
    "Read Discord's own record of what was done to this server: who kicked, banned, timed out, changed roles, "
    + 'deleted messages or edited channels, and when. Use it when somebody asks what happened to a person or a '
    + 'channel and the conversation does not say. It is a record of moderation actions, not of messages — for '
    + 'what people said, read the channel instead.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: EVENT_NAMES,
        description: 'Narrow to one kind of action. Leave it out for everything, newest first.',
      },
      userId: {
        type: 'string',
        description: 'Narrow to what one person did — the digits of their <@ID> mention. This is who acted, not who it was done to.',
      },
      limit: {
        type: 'number',
        description: `How many entries to read back, 1 to ${MAX_ENTRIES}. Keep it small; you are answering a question, not auditing.`,
      },
    },
    required: [],
  },
  handler: guarded('enableAuditLog', async (args, ctx) => {
    const guild = invocationGuild(ctx);
    const me = await botMember(guild);
    // Discord gates this on a permission the bot may simply not have. Reporting
    // the refusal is the honest answer; there is no way around it and no
    // pretending there is.
    requirePermission(me, 'ViewAuditLog', 'View Audit Log');

    const config = withDefaults(ctx.getConfig<Partial<DiscordAdminConfig>>());
    const wanted = args.action === undefined ? undefined : NAMED_EVENTS[String(args.action)];
    if (args.action !== undefined && wanted === undefined) {
      throw new Error(`action must be one of: ${EVENT_NAMES.join(', ')}.`);
    }
    const limit = args.limit === undefined ? 20 : integer(args.limit, 'limit', 1, MAX_ENTRIES);
    const userId = args.userId === undefined ? undefined : snowflake(args.userId, 'userId');

    const since = Date.now() - config.auditLogLookbackHours * 60 * 60 * 1000;

    // Paged rather than asked for in one go: Discord caps a request at 100, and
    // a filter can mean walking several pages to fill a small answer. The
    // look-back is the floor, so an old server does not page for ever.
    const entries: Record<string, unknown>[] = [];
    // Discord pages backwards from an id, so the look-back starts at the entry
    // that window begins with rather than at the newest.
    let before: string | undefined;
    let reachedCutoff = false;
    for (let page = 0; page < 5 && entries.length < limit && !reachedCutoff; page += 1) {
      const fetched = await guild.fetchAuditLogs({
        limit: PAGE,
        ...(wanted === undefined ? {} : { type: wanted }),
        ...(userId === undefined ? {} : { user: userId }),
        ...(before === undefined ? {} : { before }),
      });
      const rows = [...fetched.entries.values()];
      if (rows.length === 0) break;
      for (const entry of rows) {
        if (entry.createdTimestamp < since) { reachedCutoff = true; break; }
        if (entries.length >= limit) break;
        entries.push(view(entry));
      }
      before = rows[rows.length - 1]?.id;
      if (rows.length < PAGE) break;
    }

    return {
      entries,
      lookbackHours: config.auditLogLookbackHours,
      // An empty answer means "nothing in this window", never "nothing ever",
      // and the model has to be able to tell the difference when it answers.
      ...(entries.length === 0
        ? { note: `Nothing in the last ${config.auditLogLookbackHours} hours matched. Older entries were not read.` }
        : {}),
    };
  }),
};
