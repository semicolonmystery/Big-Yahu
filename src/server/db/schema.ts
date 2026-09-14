import { sqliteTable, text, integer, real, primaryKey, index } from 'drizzle-orm/sqlite-core';

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
  timezone: text('timezone').notNull().default('UTC'),
  retryAttempts: integer('retry_attempts').notNull().default(2),
  retryDelayMs: integer('retry_delay_ms').notNull().default(3000),
  duplicateDistance: integer('duplicate_distance').notNull().default(25),
  factSearchMaxDistance: integer('fact_search_max_distance').notNull().default(0),
  /** What new facts are embedded with. Changing either rebuilds the collection. */
  embeddingModel: text('embedding_model').notNull().default('openai/text-embedding-3-large'),
  embeddingDimensions: integer('embedding_dimensions').notNull().default(1536),
  /**
   * What the collection recall actually searches was built with. It trails the
   * two above until a re-embed finishes, because a query embedded with one model
   * and compared against another produces scores that look fine and mean nothing.
   */
  activeEmbeddingModel: text('active_embedding_model').notNull().default(''),
  activeEmbeddingDimensions: integer('active_embedding_dimensions').notNull().default(0),
  modelFailureThreshold: integer('model_failure_threshold').notNull().default(3),
  modelRestMinutes: integer('model_rest_minutes').notNull().default(120),
  visionEnabled: integer('vision_enabled', { mode: 'boolean' }).notNull().default(true),
  maxImages: integer('max_images').notNull().default(4),
  textAttachmentMaxKb: integer('text_attachment_max_kb').notNull().default(16),
  crossChannelMessages: integer('cross_channel_messages').notNull().default(30),
  overloadMessage: text('overload_message')
    .notNull()
    .default('every model I can reach is busy right now, try again in a minute'),
  // One message for four unrelated failures is why the bot said "no time" when
  // it had actually hit a bug. These split the model being unavailable from the
  // bot running out of room, and both from something being broken.
  busyMessage: text('busy_message')
    .notNull()
    .default('took me too long to work that one out, ask me again'),
  errorMessage: text('error_message')
    .notNull()
    .default('something broke on my end, thats not your fault'),
  // Terminal in a way the others are not: every model shares the key, so this
  // is the operator's problem and nothing retries out of it.
  noCreditsMessage: text('no_credits_message')
    .notNull()
    .default('im out of credit, someone whos meant to be paying for me isnt'),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Only prompts an operator has actually rewritten. A row absent means "use what
 * ships", so improvements to the shipped text still reach anyone who never
 * touched it, and resetting is a delete rather than pasting a copy back.
 *
 * Its own table rather than more `settings` columns: these are hundreds of
 * lines each, and `settings` is one row of short values.
 */
export const promptOverrides = sqliteTable('prompt_overrides', {
  id: text('id').primaryKey(),
  body: text('body').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const pluginState = sqliteTable('plugin_state', {
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  configJson: text('config_json').notNull(),
  /**
   * Whether this plugin's model calls go through the shared Plugins list. Off,
   * and each job it declares gets a list of its own. Host-side rather than in
   * the plugin's config: which models answer is the operator's business.
   */
  useSharedModels: integer('use_shared_models', { mode: 'boolean' }).notNull().default(true),
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

/**
 * One row per model call, as OpenRouter billed it. `cost` is what the account
 * was actually charged in US dollars, peak pricing and cache discounts already
 * applied, so nothing here multiplies tokens by a price that can drift from the
 * bill. A float is exact enough for sums of fractions of a cent.
 */
export const aiUsage = sqliteTable('ai_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  task: text('task').notNull(),
  model: text('model').notNull(),
  /** The upstream host that actually served the call, as OpenRouter reported it. */
  provider: text('provider'),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  cachedTokens: integer('cached_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  reasoningTokens: integer('reasoning_tokens').notNull().default(0),
  cost: real('cost').notNull().default(0),
  latencyMs: integer('latency_ms').notNull(),
  outcome: text('outcome').notNull(),
}, (table) => [index('ai_usage_at').on(table.at)]);

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
/**
 * Discord ids that may direct the bot.
 *
 * The id is all there is. There used to be a label beside it, typed by whoever
 * added the controller, which meant the panel showed a name somebody had made
 * up next to an id nobody could read. Names come from Discord now, resolved on
 * the way out, so there is nothing here to go stale when somebody renames
 * themselves.
 */
export const controllers = sqliteTable('controllers', {
  userId: text('user_id').primaryKey(),
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

/** One ordered list of OpenRouter models per AI task. */
export const taskModels = sqliteTable(
  'task_models',
  {
    task: text('task').notNull(),
    model: text('model').notNull(),
    /**
     * The OpenRouter host this row is pinned to, such as `deepseek`. Empty lets
     * OpenRouter choose, which can mean a host that charges more.
     */
    upstream: text('upstream').notNull().default(''),
    weight: integer('weight').notNull().default(100),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    restingUntil: integer('resting_until'),
    retired: integer('retired', { mode: 'boolean' }).notNull().default(false),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.task, table.model] })],
);

/** Per-task settings that are not about which models: for now, how hard it may reason. */
export const aiTasks = sqliteTable('ai_tasks', {
  task: text('task').primaryKey(),
  reasoningEffort: text('reasoning_effort').notNull().default('none'),
  updatedAt: integer('updated_at').notNull(),
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

/**
 * A move of every fact from one embedding model to another.
 *
 * It exists in SQLite rather than in memory because it is long, paid, and must
 * survive a restart: the ids are snapshotted up front so the job copies the
 * store as it was when it started, and the cursor is what stops a crash halfway
 * through from charging for the same vectors twice.
 */
export const reembedJobs = sqliteTable('reembed_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /**
   * `reembed` moves the store to another embedding model; `cleanup` rewrites
   * facts in place under the rules the bot has gained since they were stored.
   * The shape is the same either way — snapshot a set of fact ids, work through
   * them in checkpointed batches, pause, continue, reset, resume after a restart
   * — which is why there is one runner rather than two.
   */
  kind: text('kind').notNull().default('reembed'),
  /** cleanup only: which types to sort, space-packed. Empty is everything. */
  typeFilter: text('type_filter').notNull().default(''),
  /** cleanup only: how many facts go to the model at once. */
  bundleSize: integer('bundle_size').notNull().default(0),
  sourceModel: text('source_model').notNull(),
  sourceDimensions: integer('source_dimensions').notNull(),
  /** Named outright: the collection predating per-model names is simply `facts`. */
  sourceCollection: text('source_collection').notNull(),
  targetModel: text('target_model').notNull(),
  targetDimensions: integer('target_dimensions').notNull(),
  targetCollection: text('target_collection').notNull(),
  total: integer('total').notNull().default(0),
  copied: integer('copied').notNull().default(0),
  /** running | failed | complete */
  status: text('status').notNull().default('running'),
  lastError: text('last_error'),
  /**
   * Set when there is nothing to recall from yet, so the bot says it remembers
   * nothing rather than answering out of a half-filled collection.
   */
  pausesRecall: integer('pauses_recall', { mode: 'boolean' }).notNull().default(false),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
});

/** The snapshot: which facts this job promised to move, and which are across. */
export const reembedJobItems = sqliteTable(
  'reembed_job_items',
  {
    jobId: integer('job_id').notNull(),
    factId: text('fact_id').notNull(),
    copied: integer('copied', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.factId] })],
);

/**
 * The kinds of thing a fact can be, and each kind's own fact settings.
 *
 * Operator-owned: the seven shipped types are seeded on first read from
 * `BUILT_IN_FACT_TYPES`, and more can be added. The three settings live here
 * rather than only in `settings` because what counts as a duplicate of a
 * one-line message record is not what counts as a duplicate of a rule — the
 * global values stay as the seed for a new type and the fallback for a fact
 * that has no type yet.
 */
export const factTypes = sqliteTable('fact_types', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  /** Read by the model, so it can sort a fact into this type and search it. */
  description: text('description').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  builtIn: integer('built_in', { mode: 'boolean' }).notNull().default(false),
  /** Hundredths of a vector distance. 0 means never merge two facts of this type. */
  duplicateDistance: integer('duplicate_distance').notNull(),
  factSearchTopK: integer('fact_search_top_k').notNull(),
  factSearchMaxDistance: integer('fact_search_max_distance').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * What is in the fact store, in a shape SQLite can order and count.
 *
 * Chroma can neither sort a `get` by anything nor offset one, so browsing facts
 * used to mean pulling the entire collection over HTTP and sorting it in
 * memory. That was a fair trade at a few thousand facts and stops being one the
 * moment `message` starts keeping most of the channel. Nothing here is the
 * truth — Chroma is — so a mismatched count rebuilds it from scratch.
 *
 * `types` and `people` are space-delimited with a space at each end, so
 * `LIKE '% id %'` matches a whole id rather than the middle of a longer one.
 * An empty `types` is a fact nobody has typed yet, which every type search
 * includes.
 */
export const factIndex = sqliteTable('fact_index', {
  factId: text('fact_id').primaryKey(),
  guildId: text('guild_id').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  types: text('types').notNull().default(' '),
  people: text('people').notNull().default(' '),
  /** The source messages, so the dashboard can count them without reading every fact. */
  messages: text('messages').notNull().default(' '),
}, (table) => [
  index('fact_index_created_at').on(table.createdAt),
  index('fact_index_types').on(table.types),
]);
