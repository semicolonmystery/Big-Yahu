import { eq } from 'drizzle-orm';
import { db } from '../client';
import { channelSettings } from '../schema';

/**
 * Permissions are cached because they are consulted on every single message.
 * The map is small and only invalidated when an admin changes something.
 */
let cache: Map<string, { canReply: boolean; canExtract: boolean }> | null = null;

function load(): Map<string, { canReply: boolean; canExtract: boolean }> {
  if (cache) return cache;
  cache = new Map(
    db
      .select()
      .from(channelSettings)
      .all()
      .map((row) => [row.channelId, { canReply: row.canReply, canExtract: row.canExtract }]),
  );
  return cache;
}

export function invalidate(): void {
  cache = null;
}

/** A channel nobody has configured may be replied in, so the bot works out of the box. */
export function canReplyIn(channelId: string): boolean {
  return load().get(channelId)?.canReply ?? true;
}

/**
 * Reading defaults to **off**, unlike replying.
 *
 * The two are not symmetrical. Replying somewhere is visible the moment it
 * happens and is bounded by the channel it happens in. Reading mines a channel
 * into permanent memory that is then recalled guild-wide — a fact drawn from a
 * private channel comes back, with its source messages quoted, in a reply
 * somewhere public. Defaulting that on meant every channel the bot was ever
 * added to was being read unless somebody thought to say otherwise, which is the
 * wrong way round for the one permission whose mistakes are not visible.
 *
 * So an operator opts each channel in. Nothing is read until they do.
 */
export function canExtractFrom(channelId: string): boolean {
  return load().get(channelId)?.canExtract ?? false;
}

export function listChannelSettings() {
  return db.select().from(channelSettings).all();
}

export function setChannelPermissions(
  channelId: string,
  guildId: string,
  patch: { canReply?: boolean; canExtract?: boolean },
): { canReply: boolean; canExtract: boolean } {
  const existing = db.select().from(channelSettings).where(eq(channelSettings.channelId, channelId)).get();
  // The fallbacks match the unconfigured defaults above, so saving one switch
  // never quietly grants the other.
  const next = {
    canReply: patch.canReply ?? existing?.canReply ?? true,
    canExtract: patch.canExtract ?? existing?.canExtract ?? false,
  };

  db.insert(channelSettings)
    .values({ channelId, guildId, ...next, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: channelSettings.channelId, set: { ...next, updatedAt: Date.now() } })
    .run();

  invalidate();
  return next;
}
