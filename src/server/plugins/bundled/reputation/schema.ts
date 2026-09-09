import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

/** One row per person the bot has formed a view of. */
export const reputation = sqliteTable('reputation', {
  userId: text('user_id').primaryKey(),
  shortTerm: real('short_term').notNull(),
  longTerm: real('long_term').notNull(),
  /** Consecutive assessments that left short term below the threshold, driving the drag. */
  lowStreak: integer('low_streak').notNull().default(0),
  judgements: integer('judgements').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

/** Every judgement ever recorded, so a score can be explained after the fact. */
export const reputationHistory = sqliteTable('reputation_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  assessment: text('assessment').notNull(),
  shortTerm: real('short_term').notNull(),
  longTerm: real('long_term').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at').notNull(),
});
