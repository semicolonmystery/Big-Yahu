import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { env } from '../env';
import * as schema from './schema';

fs.mkdirSync(path.dirname(path.resolve(env.sqlitePath)), { recursive: true });

const sqlite = new Database(env.sqlitePath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export type Db = typeof db;

export function runMigrations(): void {
  migrate(db, { migrationsFolder: path.resolve('./drizzle') });
}

/** Call only after HTTP handlers, message handlers and extraction have drained. */
export function closeDatabase(): void {
  if (sqlite.open) sqlite.close();
}
