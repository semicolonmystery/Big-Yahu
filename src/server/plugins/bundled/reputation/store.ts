import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, inArray } from 'drizzle-orm';
import type { Database } from 'better-sqlite3';
import { reputation, reputationHistory } from './schema';
import type { Assessment, ReputationConfig, ReputationRow } from './scores';

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

function blank(userId: string, config: ReputationConfig): ReputationRow {
  return {
    userId,
    shortTerm: config.startingScore,
    longTerm: config.startingScore,
    lowStreak: 0,
    judgements: 0,
    updatedAt: 0,
  };
}

export function getRow(db: Db, userId: string, config: ReputationConfig): ReputationRow {
  const [row] = db.select().from(reputation).where(eq(reputation.userId, userId)).limit(1).all();
  return row ?? blank(userId, config);
}

/** One query for everyone in the reply window, rather than one per person. */
export function getRows(db: Db, userIds: string[], config: ReputationConfig): Map<string, ReputationRow> {
  const wanted = [...new Set(userIds)];
  const found = new Map<string, ReputationRow>();
  if (wanted.length === 0) return found;

  for (const row of db.select().from(reputation).where(inArray(reputation.userId, wanted)).all()) {
    found.set(row.userId, row);
  }
  for (const userId of wanted) {
    if (!found.has(userId)) found.set(userId, blank(userId, config));
  }
  return found;
}

export function saveRow(db: Db, row: ReputationRow, assessment: Assessment, reason: string): void {
  db.insert(reputation)
    .values(row)
    .onConflictDoUpdate({
      target: reputation.userId,
      set: {
        shortTerm: row.shortTerm,
        longTerm: row.longTerm,
        lowStreak: row.lowStreak,
        judgements: row.judgements,
        updatedAt: row.updatedAt,
      },
    })
    .run();

  db.insert(reputationHistory)
    .values({
      userId: row.userId,
      assessment,
      shortTerm: row.shortTerm,
      longTerm: row.longTerm,
      reason: reason.slice(0, 300),
      createdAt: row.updatedAt,
    })
    .run();
}

/** Worst long term first — the panel is there to spot who the bot has turned on. */
export function listRows(db: Db): ReputationRow[] {
  return db.select().from(reputation).orderBy(reputation.longTerm, reputation.shortTerm).all();
}

export function resetUser(db: Db, userId: string): void {
  db.delete(reputation).where(eq(reputation.userId, userId)).run();
  db.delete(reputationHistory).where(eq(reputationHistory.userId, userId)).run();
}

export function resetEveryone(db: Db): void {
  db.delete(reputation).run();
  db.delete(reputationHistory).run();
}
