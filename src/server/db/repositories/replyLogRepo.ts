import { and, count, desc, eq, gte } from 'drizzle-orm';
import { db } from '../client';
import { replyLog } from '../schema';
import { buildJumpLink } from '@shared/discord';
import type { ReplyLogRow } from '@shared/types';

export function logReply(entry: {
  guildId: string;
  channelId: string;
  taggedMessageId: string;
  replyMessageId: string | null;
  userId: string;
  content: string;
  factIdsUsed: string[];
}): void {
  db.insert(replyLog)
    .values({ ...entry, createdAt: Date.now() })
    .run();
}

export function getLatestReplies(limit: number): ReplyLogRow[] {
  const rows = db.select().from(replyLog).orderBy(desc(replyLog.id)).limit(limit).all();
  return rows.map((row) => ({
    ...row,
    jumpLink: row.replyMessageId ? buildJumpLink(row.guildId, row.channelId, row.replyMessageId) : null,
  }));
}

export function countReplies(): number {
  const row = db.select({ value: count() }).from(replyLog).get();
  return row?.value ?? 0;
}

/** Backs the per-user reply cap; replies already sent are the thing being limited. */
export function countRepliesForUserSince(userId: string, since: number): number {
  const row = db
    .select({ value: count() })
    .from(replyLog)
    .where(and(eq(replyLog.userId, userId), gte(replyLog.createdAt, since)))
    .get();
  return row?.value ?? 0;
}
