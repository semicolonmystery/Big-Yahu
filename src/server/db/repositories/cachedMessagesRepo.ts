import { count, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { cachedMessages } from '../schema';
import { buildJumpLink } from '@shared/discord';
import type { SourceMessage } from '@shared/types';

const CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export function cacheMessages(
  rows: Array<{
    messageId: string;
    channelId: string;
    guildId: string;
    authorId: string;
    authorUsername: string;
    content: string;
    messageCreatedAt: number;
  }>,
): void {
  if (rows.length === 0) return;
  db.transaction((transaction) => {
    for (const batch of chunk(rows, CHUNK_SIZE)) {
      transaction.insert(cachedMessages).values(batch).onConflictDoUpdate({
        target: cachedMessages.messageId,
        set: {
          authorUsername: sql`excluded.author_username`,
          content: sql`excluded.content`,
        },
      }).run();
    }
  });
}

export function getMessages(messageIds: string[]): SourceMessage[] {
  if (messageIds.length === 0) return [];
  const rows = chunk([...new Set(messageIds)], CHUNK_SIZE).flatMap((batch) =>
    db.select().from(cachedMessages).where(inArray(cachedMessages.messageId, batch)).all(),
  );
  return rows.map((row) => ({
    ...row,
    jumpLink: buildJumpLink(row.guildId, row.channelId, row.messageId),
  }));
}

/** Newest known username per author id, for resolving `<@id>` mentions in the admin panel. */
export function getUsernames(authorIds: string[]): Record<string, string> {
  const uniqueIds = [...new Set(authorIds)];
  if (uniqueIds.length === 0) return {};
  const names: Record<string, string> = {};
  const latestByAuthor = new Map<string, number>();
  for (const batch of chunk(uniqueIds, CHUNK_SIZE)) {
    const rows = db
      .select({
        authorId: cachedMessages.authorId,
        authorUsername: cachedMessages.authorUsername,
        messageCreatedAt: cachedMessages.messageCreatedAt,
      })
      .from(cachedMessages)
      .where(inArray(cachedMessages.authorId, batch))
      .all();
    for (const row of rows) {
      const latest = latestByAuthor.get(row.authorId);
      if (latest === undefined || row.messageCreatedAt > latest) {
        latestByAuthor.set(row.authorId, row.messageCreatedAt);
        names[row.authorId] = row.authorUsername;
      }
    }
  }
  return names;
}

export function countDistinctReferencedMessages(messageIds: string[]): number {
  const uniqueIds = [...new Set(messageIds)];
  if (uniqueIds.length === 0) return 0;
  let total = 0;
  for (const batch of chunk(uniqueIds, CHUNK_SIZE)) {
    const row = db
      .select({ value: count() })
      .from(cachedMessages)
      .where(inArray(cachedMessages.messageId, batch))
      .get();
    total += row?.value ?? 0;
  }
  return total;
}
