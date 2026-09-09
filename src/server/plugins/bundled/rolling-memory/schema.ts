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
