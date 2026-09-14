import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { Database } from 'better-sqlite3';
import { rollingMemories, rollingMemoryChannels } from './schema';
import type { MemoryRow, MemoryView } from './memories';

type Db = BetterSQLite3Database<Record<string, never>>;

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drizzle');

/**
 * The bot hands plugins a raw better-sqlite3 handle and leaves the schema to
 * them, so this owns its own migrations. Applied once per handle rather than on
 * every call — the migrator is idempotent, but it is not free.
 */
const migrated = new WeakSet<Database>();

export function open(database: Database): Db {
  const db = drizzle(database);
  if (!migrated.has(database)) {
    migrate(db, { migrationsFolder: MIGRATIONS });
    migrated.add(database);
  }
  return db;
}

/**
 * Every memory still being held, with its channels, freshest first. Anything on
 * its way out is left off: it is no longer something the bot is holding in mind,
 * it is something waiting to be asked about before it goes.
 */
export function listMemories(db: Db): MemoryView[] {
  const rows = db
    .select()
    .from(rollingMemories)
    .where(eq(rollingMemories.leaving, false))
    .orderBy(asc(rollingMemories.id))
    .all();
  if (rows.length === 0) return [];

  const channelsByMemory = new Map<number, string[]>();
  for (const link of db
    .select()
    .from(rollingMemoryChannels)
    .where(inArray(rollingMemoryChannels.memoryId, rows.map((row) => row.id)))
    .all()) {
    const existing = channelsByMemory.get(link.memoryId) ?? [];
    existing.push(link.channelId);
    channelsByMemory.set(link.memoryId, existing);
  }

  return rows
    .map((row) => ({ ...row, channelIds: channelsByMemory.get(row.id) ?? [] }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The named memories, whether or not they are still being held. */
function withChannels(db: Db, ids: number[]): MemoryView[] {
  const rows = db.select().from(rollingMemories).where(inArray(rollingMemories.id, ids)).all();
  const channelsByMemory = new Map<number, string[]>();
  for (const link of db
    .select()
    .from(rollingMemoryChannels)
    .where(inArray(rollingMemoryChannels.memoryId, ids))
    .all()) {
    const existing = channelsByMemory.get(link.memoryId) ?? [];
    existing.push(link.channelId);
    channelsByMemory.set(link.memoryId, existing);
  }
  return rows
    .map((row) => ({ ...row, channelIds: channelsByMemory.get(row.id) ?? [] }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createMemory(db: Db, memory: Omit<MemoryRow, 'id'>, channelIds: string[]): number {
  const [inserted] = db.insert(rollingMemories).values(memory).returning({ id: rollingMemories.id }).all();
  linkChannels(db, inserted.id, channelIds);
  return inserted.id;
}

export function linkChannels(db: Db, memoryId: number, channelIds: string[]): void {
  for (const channelId of new Set(channelIds)) {
    db.insert(rollingMemoryChannels).values({ memoryId, channelId }).onConflictDoNothing().run();
  }
}

export function reviseMemory(db: Db, id: number, text: string, now: number): boolean {
  const changes = db
    .update(rollingMemories)
    .set({ text, updatedAt: now })
    .where(eq(rollingMemories.id, id))
    .run();
  return changes.changes > 0;
}

/** Puts a memory's counter back to full. Used when it is still being talked about. */
export function refreshMemories(db: Db, ids: number[], now: number): number {
  if (ids.length === 0) return 0;
  const changes = db
    .update(rollingMemories)
    .set({ remaining: sql`${rollingMemories.lifespan}`, updatedAt: now })
    .where(inArray(rollingMemories.id, ids))
    .run();
  return changes.changes;
}

export function deleteMemories(db: Db, ids: number[]): number {
  if (ids.length === 0) return 0;
  db.delete(rollingMemoryChannels).where(inArray(rollingMemoryChannels.memoryId, ids)).run();
  return db.delete(rollingMemories).where(inArray(rollingMemories.id, ids)).run().changes;
}

/**
 * One message, one tick, across every memory. Not floored at zero: expiry is a
 * decision the model makes, and it needs to see that something has run out.
 */
export function tick(db: Db): void {
  db.update(rollingMemories)
    .set({ remaining: sql`${rollingMemories.remaining} - 1` })
    .where(sql`${rollingMemories.remaining} > -1`)
    .run();
}

/**
 * Everything on its way out: run out of life, forgotten by the bot, or dropped
 * by compaction. Each is offered for promotion before it goes, so the one
 * durable fact inside a memory is never lost simply because it stopped being
 * current.
 */
export function departingMemories(db: Db): MemoryView[] {
  const ids = db
    .select({ id: rollingMemories.id })
    .from(rollingMemories)
    .where(or(eq(rollingMemories.leaving, true), lte(rollingMemories.remaining, 0)))
    .all()
    .map((row) => row.id);
  if (ids.length === 0) return [];
  return withChannels(db, ids);
}

/** Marks memories as on their way out. They stop being shown and wait for the next upkeep. */
export function markLeaving(db: Db, ids: number[]): number {
  if (ids.length === 0) return 0;
  return db
    .update(rollingMemories)
    .set({ leaving: true })
    .where(inArray(rollingMemories.id, ids))
    .run().changes;
}

