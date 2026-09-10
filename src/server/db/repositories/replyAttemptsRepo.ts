import { and, count, eq, gte, lt } from 'drizzle-orm';
import { db } from '../client';
import { replyAttempts } from '../schema';
import { RATE_LIMIT_WINDOW_MS } from '@shared/constants';

/** Synchronous SQLite transaction: reservation happens before any AI work. */
export function reserveReplyAttempt(messageId: string, userId: string, limit: number, now = Date.now()): boolean {
  return db.transaction((tx) => {
    tx.delete(replyAttempts).where(lt(replyAttempts.createdAt, now - RATE_LIMIT_WINDOW_MS)).run();
    const used = tx.select({ total: count() }).from(replyAttempts)
      .where(and(eq(replyAttempts.userId, userId), gte(replyAttempts.createdAt, now - RATE_LIMIT_WINDOW_MS))).get();
    if ((used?.total ?? 0) >= limit) return false;
    return tx.insert(replyAttempts).values({ messageId, userId, createdAt: now }).onConflictDoNothing().run().changes > 0;
  }, { behavior: 'immediate' });
}
