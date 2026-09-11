import { desc, eq } from 'drizzle-orm';
import { db } from '../client';
import { chatModels } from '../schema';
import { getSettings } from './settingsRepo';
import type { ChatModel } from '@shared/types';

export function listModels(): ChatModel[] {
  return db.select().from(chatModels).orderBy(desc(chatModels.weight)).all();
}

export function addModel(model: string, weight: number): ChatModel {
  const row = { model, weight, consecutiveFailures: 0, restingUntil: null, retired: false, lastError: null, createdAt: Date.now() };
  db.insert(chatModels).values(row).onConflictDoUpdate({ target: chatModels.model, set: { weight } }).run();
  return row;
}

export function setWeight(model: string, weight: number): boolean {
  const existing = db.select().from(chatModels).where(eq(chatModels.model, model)).get();
  if (!existing) return false;
  db.update(chatModels).set({ weight }).where(eq(chatModels.model, model)).run();
  return true;
}

/**
 * Persists a drag-and-drop ordering. Weights are re-spread from the top so the
 * first entry is always tried first; models not named keep their place below.
 */
export function reorderModels(order: string[]): ChatModel[] {
  const known = new Set(listModels().map((entry) => entry.model));
  const ordered = order.filter((model) => known.has(model));
  const step = 10;
  let weight = ordered.length * step;

  for (const model of ordered) {
    db.update(chatModels).set({ weight }).where(eq(chatModels.model, model)).run();
    weight -= step;
  }
  return listModels();
}

export function removeModel(model: string): boolean {
  const existing = db.select().from(chatModels).where(eq(chatModels.model, model)).get();
  if (!existing) return false;
  db.delete(chatModels).where(eq(chatModels.model, model)).run();
  return true;
}

/**
 * Clears every rest period and failure count, and brings retired models back.
 *
 * This is what "Reset errors" in the panel does, and it is the *only* thing
 * that un-retires a model — the point of retiring is that nothing automatic
 * ever tries it again.
 */
export function reviveAll(): void {
  db.update(chatModels).set({ consecutiveFailures: 0, restingUntil: null, retired: false, lastError: null }).run();
}

/** Rest periods only, so the automatic fallback below cannot resurrect a dead model. */
function reviveResting(): void {
  db.update(chatModels)
    .set({ consecutiveFailures: 0, restingUntil: null, lastError: null })
    .where(eq(chatModels.retired, false))
    .run();
}

/**
 * Models to try this call, best first. Anything resting is left out — unless
 * that would leave nothing, in which case every model is revived and the whole
 * pool comes back, since refusing to answer is worse than trying a shaky model.
 */
export function selectCandidates(): ChatModel[] {
  const now = Date.now();
  // Retired models are not in the pool at all. Unlike resting, this is never
  // lifted automatically: the API said the model does not exist, and it will
  // still not exist in two hours.
  const live = listModels().filter((entry) => !entry.retired);
  const available = live.filter((entry) => (entry.restingUntil ?? 0) <= now);
  if (available.length > 0) return available;
  if (live.length === 0) return [];

  console.warn('[ai] every model is resting; clearing all rest periods and starting over');
  reviveResting();
  return listModels().filter((entry) => !entry.retired);
}

/** Takes a model out of the pool for good. Only "Reset errors" brings it back. */
export function retireModel(model: string, error: string): boolean {
  const existing = db.select().from(chatModels).where(eq(chatModels.model, model)).get();
  if (!existing) return false;
  db.update(chatModels)
    .set({ retired: true, restingUntil: null, lastError: error.slice(0, 300) })
    .where(eq(chatModels.model, model))
    .run();
  return true;
}

/** Whether the pool holds models but every one of them has been retired. */
export function allRetired(): boolean {
  const all = listModels();
  return all.length > 0 && all.every((entry) => entry.retired);
}

export function recordSuccess(model: string): void {
  db.update(chatModels)
    .set({ consecutiveFailures: 0, restingUntil: null, lastError: null })
    .where(eq(chatModels.model, model))
    .run();
}

/** Returns true when this failure put the model to rest. */
export function recordFailure(model: string, error: string): boolean {
  const existing = db.select().from(chatModels).where(eq(chatModels.model, model)).get();
  if (!existing) return false;

  const { modelFailureThreshold, modelRestMinutes } = getSettings();
  const failures = existing.consecutiveFailures + 1;
  const resting = failures >= modelFailureThreshold;

  db.update(chatModels)
    .set({
      consecutiveFailures: failures,
      restingUntil: resting ? Date.now() + modelRestMinutes * 60_000 : null,
      lastError: error.slice(0, 300),
    })
    .where(eq(chatModels.model, model))
    .run();

  return resting;
}

/** Carries the single-model setting into the pool the first time it is used. */
export function seedFromSettings(): void {
  if (listModels().length > 0) return;
  const { chatModel } = getSettings();
  if (chatModel) {
    addModel(chatModel, 100);
    console.log(`[ai] seeded the model pool with ${chatModel}`);
  }
}
