import { eq } from 'drizzle-orm';
import { db } from '../client';
import { channelCheckpoints } from '../schema';

export function getCheckpoint(channelId: string) {
  return db.select().from(channelCheckpoints).where(eq(channelCheckpoints.channelId, channelId)).get();
}

export function listCheckpoints() {
  return db.select().from(channelCheckpoints).all();
}

export function ensureChannel(channelId: string, guildId: string): void {
  db.insert(channelCheckpoints)
    .values({ channelId, guildId, lastMessageId: null, lastCheckedAt: null })
    .onConflictDoNothing()
    .run();
}

export function advanceCheckpoint(channelId: string, lastMessageId: string | null): void {
  db.update(channelCheckpoints)
    .set({
      ...(lastMessageId !== null ? { lastMessageId } : {}),
      lastCheckedAt: Date.now(),
    })
    .where(eq(channelCheckpoints.channelId, channelId))
    .run();
}
