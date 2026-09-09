import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { pluginEnv } from '../schema';
import { decryptSecret, encryptSecret } from '../../plugins/secrets';

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function isValidEnvKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** Names only — safe to show without re-authenticating. */
export function listEnvKeys(pluginId: string): string[] {
  return db
    .select({ key: pluginEnv.key })
    .from(pluginEnv)
    .where(eq(pluginEnv.pluginId, pluginId))
    .all()
    .map((row) => row.key);
}

export function readEnv(pluginId: string): Record<string, string> {
  const rows = db.select().from(pluginEnv).where(eq(pluginEnv.pluginId, pluginId)).all();
  const result: Record<string, string> = {};
  for (const row of rows) {
    try {
      result[row.key] = decryptSecret(row.valueEncrypted);
    } catch {
      // A value encrypted under a key we no longer hold is unreadable, not fatal.
      result[row.key] = '';
    }
  }
  return result;
}

export function setEnv(pluginId: string, values: Record<string, string>): void {
  const now = Date.now();
  for (const [key, value] of Object.entries(values)) {
    if (!isValidEnvKey(key)) throw new Error(`"${key}" is not a valid variable name`);
    db.insert(pluginEnv)
      .values({ pluginId, key, valueEncrypted: encryptSecret(value), updatedAt: now })
      .onConflictDoUpdate({
        target: [pluginEnv.pluginId, pluginEnv.key],
        set: { valueEncrypted: encryptSecret(value), updatedAt: now },
      })
      .run();
  }
}

export function deleteEnv(pluginId: string, key: string): boolean {
  const existing = db
    .select()
    .from(pluginEnv)
    .where(and(eq(pluginEnv.pluginId, pluginId), eq(pluginEnv.key, key)))
    .get();
  if (!existing) return false;
  db.delete(pluginEnv).where(and(eq(pluginEnv.pluginId, pluginId), eq(pluginEnv.key, key))).run();
  return true;
}

export function deleteAllEnv(pluginId: string): void {
  db.delete(pluginEnv).where(eq(pluginEnv.pluginId, pluginId)).run();
}
