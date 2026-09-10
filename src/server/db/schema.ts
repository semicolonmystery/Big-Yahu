import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

/** Mono-account system: this table holds at most one row, always id 1. */
export const adminUser = sqliteTable('admin_user', {
  id: integer('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
  /** Set by re-entering the password; secrets stay hidden until then. */
  elevatedUntil: integer('elevated_until'),
});

/** Single row, always id 1. */
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  checkIntervalMinutes: integer('check_interval_minutes').notNull(),
  replyContextMessages: integer('reply_context_messages').notNull(),
  factSearchTopK: integer('fact_search_top_k').notNull(),
  escalationLookbackHours: integer('escalation_lookback_hours').notNull(),
  maxEscalationDepth: integer('max_escalation_depth').notNull(),
  replyLanguage: text('reply_language').notNull().default('en'),
  rateLimitPerHour: integer('rate_limit_per_hour').notNull().default(40),
  rateLimitMessage: text('rate_limit_message')
    .notNull()
    .default("You've hit me up a lot this hour — give me a bit and try again."),
  chatModel: text('chat_model').notNull().default('gemini-3.1-flash-lite'),
  timezone: text('timezone').notNull().default('UTC'),
  retryAttempts: integer('retry_attempts').notNull().default(2),
  retryDelayMs: integer('retry_delay_ms').notNull().default(3000),
  duplicateDistance: integer('duplicate_distance').notNull().default(25),
  modelFailureThreshold: integer('model_failure_threshold').notNull().default(3),
  modelRestMinutes: integer('model_rest_minutes').notNull().default(120),
  visionEnabled: integer('vision_enabled', { mode: 'boolean' }).notNull().default(true),
  maxImages: integer('max_images').notNull().default(4),
  textAttachmentMaxKb: integer('text_attachment_max_kb').notNull().default(16),
  crossChannelMessages: integer('cross_channel_messages').notNull().default(30),
  overloadMessage: text('overload_message')
    .notNull()
    .default("Gemini's getting hammered right now and won't talk to me. Try again in a minute."),
  updatedAt: integer('updated_at').notNull(),
});

export const pluginState = sqliteTable('plugin_state', {
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  configJson: text('config_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const replyLog = sqliteTable('reply_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id').notNull(),
  taggedMessageId: text('tagged_message_id').notNull(),
  replyMessageId: text('reply_message_id'),
  userId: text('user_id').notNull(),
  content: text('content').notNull(),
  factIdsUsed: text('fact_ids_used', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Admitted work counts even when the model fails or chooses silence. */
export const replyAttempts = sqliteTable('reply_attempts', {
  messageId: text('message_id').primaryKey(),
  userId: text('user_id').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [index('reply_attempts_user_time').on(table.userId, table.createdAt)]);

/** Tracks how far the hourly extraction has read in each channel. */
export const channelCheckpoints = sqliteTable('channel_checkpoints', {
  channelId: text('channel_id').primaryKey(),
  guildId: text('guild_id').notNull(),
  lastMessageId: text('last_message_id'),
  lastCheckedAt: integer('last_checked_at'),
});

/** Message text is copied here as it is processed so facts keep their sources even if Discord loses them. */
export const cachedMessages = sqliteTable('cached_messages', {
  messageId: text('message_id').primaryKey(),
  channelId: text('channel_id').notNull(),
  guildId: text('guild_id').notNull(),
  authorId: text('author_id').notNull(),
  authorUsername: text('author_username').notNull(),
  content: text('content').notNull(),
  messageCreatedAt: integer('message_created_at').notNull(),
});

/** Discord users allowed to command the bot: adding and deleting facts on request. */
export const controllers = sqliteTable('controllers', {
  userId: text('user_id').primaryKey(),
  label: text('label').notNull(),
  addedAt: integer('added_at').notNull(),
});

/** Plugin secrets, encrypted at rest and kept apart from the plain JSON config. */
export const pluginEnv = sqliteTable(
  'plugin_env',
  {
    pluginId: text('plugin_id').notNull(),
    key: text('key').notNull(),
    valueEncrypted: text('value_encrypted').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.key] })],
);

/**
 * The pool of chat models. The highest weight is tried first; a model that
 * fails repeatedly is rested for a while rather than retried into the ground.
 */
export const chatModels = sqliteTable('chat_models', {
  model: text('model').primaryKey(),
  weight: integer('weight').notNull().default(100),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  restingUntil: integer('resting_until'),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
});

/** Per-plugin key/value store. Rows are only ever reachable through that plugin's own context. */
export const pluginStorage = sqliteTable(
  'plugin_storage',
  {
    pluginId: text('plugin_id').notNull(),
    key: text('key').notNull(),
    valueJson: text('value_json').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.key] })],
);

/**
 * Per-channel permissions. A channel with no row may be replied in but is never
 * read for facts — reading feeds permanent, guild-wide memory, so it is opted
 * into rather than out of.
 */
export const channelSettings = sqliteTable('channel_settings', {
  channelId: text('channel_id').primaryKey(),
  guildId: text('guild_id').notNull(),
  canReply: integer('can_reply', { mode: 'boolean' }).notNull().default(true),
  canExtract: integer('can_extract', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
});
