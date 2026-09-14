import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

/**
 * One thing the bot is currently holding in mind. Lifespans are counted in
 * messages, not minutes: a channel that goes quiet for two days should still
 * remember what it was in the middle of, and a channel doing three hundred
 * messages an hour should not.
 */
export const rollingMemories = sqliteTable('rolling_memories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
  /** Messages left before it expires. Every message the bot sees takes one. */
  remaining: integer('remaining').notNull(),
  /** What `remaining` started at, so a score needs no second table to work out. */
  lifespan: integer('lifespan').notNull(),
  /** JSON array of the message ids this came from, so promoting it to a fact keeps its sources. */
  messageIds: text('message_ids').notNull().default('[]'),
  /**
   * Where it was said. Kept on the row so a memory can be promoted into a fact
   * from anywhere — the operator's page has no Discord message to read it from.
   */
  guildId: text('guild_id').notNull().default(''),
  /**
   * On its way out: expired, forgotten, or dropped by compaction. It stops being
   * shown, and the next upkeep asks whether any of it is worth keeping forever
   * before it goes. Deleting outright is how a memory's one durable fact was lost.
   */
  leaving: integer('leaving', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Memories are global — the bot is one mind, not one per channel — but each is
 * linked to wherever it was actually said, so it can tell somebody that a thing
 * was being discussed elsewhere rather than pretending it happened here.
 */
export const rollingMemoryChannels = sqliteTable(
  'rolling_memory_channels',
  {
    memoryId: integer('memory_id').notNull(),
    channelId: text('channel_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.memoryId, table.channelId] })],
);
