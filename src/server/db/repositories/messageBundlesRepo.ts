import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { messageBundles } from '../schema';

/**
 * The fixed points a channel's history is cut at.
 *
 * Caching pays only when a request begins with exactly what an earlier one
 * began with, and a sliding window never does — every new message shifts
 * everything behind it. Bundles are cut once and never move, so the same run of
 * messages is the same bytes on every call that includes it.
 */

export interface MessageBundle {
  id: number;
  channelId: string;
  messageIds: string[];
}

const packed = (ids: readonly string[]): string => ids.join(' ');
const unpacked = (value: string): string[] => value.trim().split(/\s+/).filter(Boolean);

/** Oldest first, which is the order they have to be sent in. */
export function bundlesFor(channelId: string): MessageBundle[] {
  return db.select().from(messageBundles)
    .where(eq(messageBundles.channelId, channelId))
    .orderBy(asc(messageBundles.firstMessageId))
    .all()
    .map((row) => ({ id: row.id, channelId: row.channelId, messageIds: unpacked(row.messageIds) }));
}

/**
 * Cuts whatever complete bundles the given history allows, and leaves the rest.
 *
 * Only a bundle that can be filled exactly is sealed. A short one would have to
 * grow when the next message arrives, and growing is the one thing a bundle must
 * never do: its bytes would change and every request built on it would miss.
 *
 * `ordered` is the channel's messages oldest first. Anything already bundled is
 * skipped, so this is safe to call on every reply with an overlapping window.
 */
export function sealBundles(channelId: string, ordered: readonly string[], size: number): number {
  if (size < 2 || ordered.length === 0) return 0;

  const already = new Set(bundlesFor(channelId).flatMap((bundle) => bundle.messageIds));
  const loose = ordered.filter((id) => !already.has(id));
  if (loose.length < size) return 0;

  const now = Date.now();
  const rows: Array<typeof messageBundles.$inferInsert> = [];
  for (let at = 0; at + size <= loose.length; at += size) {
    const group = loose.slice(at, at + size);
    rows.push({ channelId, messageIds: packed(group), firstMessageId: group[0], sealedAt: now });
  }
  if (rows.length === 0) return 0;
  db.insert(messageBundles).values(rows).run();
  return rows.length;
}

export function bundleCount(): number {
  return db.select({ count: sql<number>`count(*)` }).from(messageBundles).get()?.count ?? 0;
}

/**
 * Throws every bundle away.
 *
 * What this costs is cache hits and nothing else — the messages are elsewhere
 * and the bundles are only a record of where the cuts were. It is what has to
 * happen when the size changes, because bundles of two and bundles of five
 * cannot be told apart once they are in the table, and a request mixing the two
 * would cache nothing while looking like it should.
 */
export function clearBundles(): void {
  db.delete(messageBundles).run();
}
