import type { PluginTool } from '@big-yahu/plugin-sdk';
import {
  auditReason,
  botMember,
  guarded,
  integer,
  invocationChannel,
  invocationGuild,
  mutationConfirmationRequired,
  requireChannelPermission,
  snowflake,
} from './support';

// Controllers always. Anyone else only once the operator turns on
// autonomousModeration, which also lets the bot act on its own judgement.
const CONTROLLER_ONLY = {
  requiresController: true,
  controllerBypassConfig: 'autonomousModeration',
} as const;

const DEFAULT_READ_PINS_LIMIT = 10;
const MAX_READ_PINS_LIMIT = 50;

/** Pin pagination is by when a message was pinned, not by message id, so `before` is a timestamp. */
function pinnedBefore(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('before must be an ISO-8601 timestamp.');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('before must be a valid timestamp.');
  return date;
}

export const pinTools: PluginTool[] = [
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enablePinning',
    name: 'pin_message',
    effect: true,
    description:
      'Pin a message in this channel, so it stays visible above the normal scroll. Use for something worth being '
      + 'able to find again later, not as a reaction to a message you liked.',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'The id of the message to pin, as digits only.' },
        reason: { type: 'string', description: 'Why this is worth pinning. Visible in Discord\'s audit log.' },
      },
      required: ['messageId', 'reason'],
    },
    handler: guarded('enablePinning', async (args, ctx) => {
      const messageId = snowflake(args.messageId, 'messageId');
      const reason = auditReason(ctx, args.reason);
      const confirmation = mutationConfirmationRequired(ctx, `PIN MESSAGE ${messageId}`, { messageId, reason });
      if (confirmation) return confirmation;

      const channel = await invocationChannel(ctx);
      const me = await botMember(invocationGuild(ctx));
      requireChannelPermission(channel, me, 'ManageMessages', 'Manage Messages');
      await channel.messages.pin(messageId, reason);
      return { success: true, pinned: messageId };
    }),
  },
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enablePinning',
    name: 'unpin_message',
    effect: true,
    description: 'Unpin a message in this channel that no longer needs to stay pinned.',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'The id of the pinned message to remove, as digits only.' },
        reason: { type: 'string', description: 'Why. Visible in Discord\'s audit log.' },
      },
      required: ['messageId', 'reason'],
    },
    handler: guarded('enablePinning', async (args, ctx) => {
      const messageId = snowflake(args.messageId, 'messageId');
      const reason = auditReason(ctx, args.reason);
      const confirmation = mutationConfirmationRequired(ctx, `UNPIN MESSAGE ${messageId}`, { messageId, reason });
      if (confirmation) return confirmation;

      const channel = await invocationChannel(ctx);
      const me = await botMember(invocationGuild(ctx));
      requireChannelPermission(channel, me, 'ManageMessages', 'Manage Messages');
      await channel.messages.unpin(messageId, reason);
      return { success: true, unpinned: messageId };
    }),
  },
  {
    ...CONTROLLER_ONLY,
    enabledByConfig: 'enablePinning',
    name: 'read_pins',
    description:
      'Look further back than the handful of pinned messages already shown to you, for pins older than those. '
      + 'Use `before` with the `pinnedAt` of the oldest pin you have already seen to page further back.',
    parameters: {
      type: 'object',
      properties: {
        before: {
          type: 'string',
          description: 'Only return pins made before this ISO-8601 timestamp (a pin\'s own `pinnedAt`).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_READ_PINS_LIMIT,
          description: `How many to return, 1 to ${MAX_READ_PINS_LIMIT}. Defaults to ${DEFAULT_READ_PINS_LIMIT}.`,
        },
      },
      required: [],
    },
    // A lookup the reply depends on: effect is deliberately left unset.
    handler: guarded('enablePinning', async (args, ctx) => {
      const before = pinnedBefore(args.before);
      const limit = args.limit === undefined
        ? DEFAULT_READ_PINS_LIMIT
        : integer(args.limit, 'limit', 1, MAX_READ_PINS_LIMIT);

      const channel = await invocationChannel(ctx);
      const { items, hasMore } = await channel.messages.fetchPins({
        limit,
        ...(before === undefined ? {} : { before }),
      });
      return {
        success: true,
        hasMore,
        pins: items.map((item) => ({
          messageId: item.message.id,
          authorId: item.message.author.id,
          content: item.message.content,
          pinnedAt: new Date(item.pinnedTimestamp).toISOString(),
        })),
      };
    }),
  },
];
