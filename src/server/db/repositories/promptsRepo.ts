import { eq } from 'drizzle-orm';
import { db } from '../client';
import { promptOverrides } from '../schema';
import { PROMPTS, type PromptId } from '../../ai/prompts/registry';

/** The operator's version, or null when they have never written one. */
export function getOverride(id: PromptId): string | null {
  return db.select().from(promptOverrides).where(eq(promptOverrides.id, id)).get()?.body ?? null;
}

/** What the bot should actually use: the override if there is one, else what ships. */
export function effectivePrompt(id: PromptId): string {
  return getOverride(id) ?? PROMPTS[id].fallback;
}

export function setOverride(id: PromptId, body: string): void {
  db.insert(promptOverrides)
    .values({ id, body, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: promptOverrides.id, set: { body, updatedAt: Date.now() } })
    .run();
}

/** Deleting the row is the reset — the shipped text is never copied into it. */
export function clearOverride(id: PromptId): boolean {
  const existing = db.select().from(promptOverrides).where(eq(promptOverrides.id, id)).get();
  if (!existing) return false;
  db.delete(promptOverrides).where(eq(promptOverrides.id, id)).run();
  return true;
}

export function listOverrideTimes(): Record<string, number> {
  const rows = db.select().from(promptOverrides).all();
  return Object.fromEntries(rows.map((row) => [row.id, row.updatedAt]));
}
