import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { pluginStorage } from '../schema';

/**
 * A plugin's own scratch space. Every call is scoped to one plugin id, which is
 * supplied by the engine and never by the plugin, so one plugin cannot read
 * another's rows.
 */
export interface PluginStorage {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  keys(): string[];
  clear(): void;
}

export function storageFor(pluginId: string): PluginStorage {
  return {
    get<T = unknown>(key: string): T | undefined {
      const row = db
        .select()
        .from(pluginStorage)
        .where(and(eq(pluginStorage.pluginId, pluginId), eq(pluginStorage.key, key)))
        .get();
      if (!row) return undefined;
      try {
        return JSON.parse(row.valueJson) as T;
      } catch {
        return undefined;
      }
    },

    set(key: string, value: unknown): void {
      const valueJson = JSON.stringify(value ?? null);
      const updatedAt = Date.now();
      db.insert(pluginStorage)
        .values({ pluginId, key, valueJson, updatedAt })
        .onConflictDoUpdate({
          target: [pluginStorage.pluginId, pluginStorage.key],
          set: { valueJson, updatedAt },
        })
        .run();
    },

    delete(key: string): boolean {
      const where = and(eq(pluginStorage.pluginId, pluginId), eq(pluginStorage.key, key));
      const existing = db.select().from(pluginStorage).where(where).get();
      if (!existing) return false;
      db.delete(pluginStorage).where(where).run();
      return true;
    },

    keys(): string[] {
      return db
        .select({ key: pluginStorage.key })
        .from(pluginStorage)
        .where(eq(pluginStorage.pluginId, pluginId))
        .all()
        .map((row) => row.key);
    },

    clear(): void {
      db.delete(pluginStorage).where(eq(pluginStorage.pluginId, pluginId)).run();
    },
  };
}

export function clearStorage(pluginId: string): void {
  db.delete(pluginStorage).where(eq(pluginStorage.pluginId, pluginId)).run();
}
