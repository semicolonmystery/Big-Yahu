import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as PluginDatabase } from 'better-sqlite3';
import { env } from '../env';

/**
 * One SQLite file per plugin, kept apart from the plugin's code so updating or
 * reinstalling it does not throw away its data. Isolation here is a property of
 * the filesystem rather than of every query being scoped by hand.
 */
export const PLUGIN_DATA_DIR = path.resolve(
  path.dirname(path.resolve(env.sqlitePath)),
  'plugin-data',
);

const open = new Map<string, PluginDatabase>();

function fileFor(pluginId: string): string {
  const file = path.join(PLUGIN_DATA_DIR, `${pluginId}.sqlite3`);
  if (!path.resolve(file).startsWith(PLUGIN_DATA_DIR + path.sep)) {
    throw new Error(`Refusing to open a database outside the plugin data directory for "${pluginId}"`);
  }
  return file;
}

/** Opened on first use, so a plugin that never touches it never gets a file. */
export function databaseFor(pluginId: string): PluginDatabase {
  const existing = open.get(pluginId);
  if (existing) return existing;

  fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
  const database = new Database(fileFor(pluginId));
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  open.set(pluginId, database);
  return database;
}

export function closeDatabase(pluginId: string): void {
  const database = open.get(pluginId);
  if (!database) return;
  try {
    database.close();
  } catch (error) {
    console.error(`[plugins] failed to close the database for ${pluginId}:`, error);
  }
  open.delete(pluginId);
}

/** Called before a reload so a replaced plugin does not leave a handle behind. */
export function closeAllDatabases(): void {
  for (const pluginId of [...open.keys()]) closeDatabase(pluginId);
}

export function deleteDatabase(pluginId: string): void {
  closeDatabase(pluginId);
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${fileFor(pluginId)}${suffix}`, { force: true });
  }
}
