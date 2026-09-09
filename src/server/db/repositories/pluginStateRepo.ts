import { eq } from 'drizzle-orm';
import { db } from '../client';
import { pluginState } from '../schema';

function parseConfig(configJson: string): Record<string, unknown> {
  try {
    return JSON.parse(configJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function seedPlugin(id: string, enabled: boolean, defaultConfig: Record<string, unknown>): void {
  db.insert(pluginState)
    .values({ id, enabled, configJson: JSON.stringify(defaultConfig), updatedAt: Date.now() })
    .onConflictDoNothing()
    .run();
}

export function getState(id: string): { enabled: boolean; config: Record<string, unknown> } | undefined {
  const row = db.select().from(pluginState).where(eq(pluginState.id, id)).get();
  if (!row) return undefined;
  return { enabled: row.enabled, config: parseConfig(row.configJson) };
}

export function listStates(): Record<string, { enabled: boolean; config: Record<string, unknown> }> {
  const rows = db.select().from(pluginState).all();
  const result: Record<string, { enabled: boolean; config: Record<string, unknown> }> = {};
  for (const row of rows) {
    result[row.id] = { enabled: row.enabled, config: parseConfig(row.configJson) };
  }
  return result;
}

export function setState(id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): void {
  db.update(pluginState)
    .set({
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.config !== undefined ? { configJson: JSON.stringify(patch.config) } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(pluginState.id, id))
    .run();
}
