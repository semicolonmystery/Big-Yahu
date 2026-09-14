import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../client';
import { taskModels } from '../schema';
import { getSettings } from './settingsRepo';
import type { TaskModel } from '@shared/types';

/**
 * One ordered model list per task — the same weights, rest periods and
 * retirement as the single Gemini pool, kept per list. Retiring is the one
 * thing that crosses lists: a model OpenRouter says does not exist is gone
 * from every list at once.
 */

const rowOf = (task: string, model: string) => and(eq(taskModels.task, task), eq(taskModels.model, model));

function view(row: typeof taskModels.$inferSelect): TaskModel {
  return {
    task: row.task,
    model: row.model,
    upstream: row.upstream,
    weight: row.weight,
    consecutiveFailures: row.consecutiveFailures,
    restingUntil: row.restingUntil,
    retired: row.retired,
    lastError: row.lastError,
  };
}

/** Best first. Ties go to whichever was added first. */
export function listTaskModels(task: string): TaskModel[] {
  return db
    .select()
    .from(taskModels)
    .where(eq(taskModels.task, task))
    .orderBy(desc(taskModels.weight), asc(taskModels.createdAt))
    .all()
    .map(view);
}

/**
 * Adds a model to the bottom of a list, as the last fallback. Adding one that is
 * already there only changes its pin, so nothing loses its place by accident.
 */
export function addTaskModel(task: string, model: string, upstream: string): TaskModel {
  const existing = listTaskModels(task);
  if (existing.some((entry) => entry.model === model)) {
    db.update(taskModels).set({ upstream }).where(rowOf(task, model)).run();
  } else {
    const weight = existing.length > 0 ? Math.min(...existing.map((entry) => entry.weight)) - 10 : 100;
    db.insert(taskModels).values({ task, model, upstream, weight, createdAt: Date.now() }).run();
  }
  return listTaskModels(task).find((entry) => entry.model === model)!;
}

export function setTaskModelUpstream(task: string, model: string, upstream: string): boolean {
  return db.update(taskModels).set({ upstream }).where(rowOf(task, model)).run().changes > 0;
}

/** Persists a drag-and-drop order. Models not named keep their place below. */
export function reorderTaskModels(task: string, order: string[]): TaskModel[] {
  const known = new Set(listTaskModels(task).map((entry) => entry.model));
  const ordered = order.filter((model) => known.has(model));
  const step = 10;
  let weight = ordered.length * step;
  for (const model of ordered) {
    db.update(taskModels).set({ weight }).where(rowOf(task, model)).run();
    weight -= step;
  }
  return listTaskModels(task);
}

export function removeTaskModel(task: string, model: string): boolean {
  return db.delete(taskModels).where(rowOf(task, model)).run().changes > 0;
}

/**
 * "Reset errors" for one list: rest periods, failure counts, and retirement.
 * This is the only thing that un-retires a row.
 */
export function reviveTask(task: string): void {
  db.update(taskModels)
    .set({ consecutiveFailures: 0, restingUntil: null, retired: false, lastError: null })
    .where(eq(taskModels.task, task))
    .run();
}

/** Rest periods only, so the automatic fallback below cannot resurrect a model that does not exist. */
function reviveResting(task: string): void {
  db.update(taskModels)
    .set({ consecutiveFailures: 0, restingUntil: null, lastError: null })
    .where(and(eq(taskModels.task, task), eq(taskModels.retired, false)))
    .run();
}

/**
 * Models to try for one call, best first. Anything resting is left out, unless
 * that would leave nothing: refusing to answer is worse than trying a shaky
 * model, so the whole list comes back. Retired models never do.
 */
export function selectTaskCandidates(task: string): TaskModel[] {
  const now = Date.now();
  const live = listTaskModels(task).filter((entry) => !entry.retired);
  const available = live.filter((entry) => (entry.restingUntil ?? 0) <= now);
  if (available.length > 0) return available;
  if (live.length === 0) return [];

  console.warn(`[ai] every ${task} model is resting; clearing its rest periods and starting over`);
  reviveResting(task);
  return listTaskModels(task).filter((entry) => !entry.retired);
}

/** Whether a list holds models but every one has been retired. */
export function allTaskModelsRetired(task: string): boolean {
  const all = listTaskModels(task);
  return all.length > 0 && all.every((entry) => entry.retired);
}

/** Takes a model out of every list: it does not exist for any task. Only Reset errors brings a row back. */
export function retireModelEverywhere(model: string, error: string): void {
  db.update(taskModels)
    .set({ retired: true, restingUntil: null, lastError: error.slice(0, 300) })
    .where(eq(taskModels.model, model))
    .run();
}

export function recordTaskSuccess(task: string, model: string): void {
  db.update(taskModels)
    .set({ consecutiveFailures: 0, restingUntil: null, lastError: null })
    .where(rowOf(task, model))
    .run();
}

/** Returns true when this failure put the row to rest. */
export function recordTaskFailure(task: string, model: string, error: string): boolean {
  const existing = db.select().from(taskModels).where(rowOf(task, model)).get();
  if (!existing) return false;

  const { modelFailureThreshold, modelRestMinutes } = getSettings();
  const failures = existing.consecutiveFailures + 1;
  const resting = failures >= modelFailureThreshold;
  db.update(taskModels)
    .set({
      consecutiveFailures: failures,
      restingUntil: resting ? Date.now() + modelRestMinutes * 60_000 : null,
      lastError: error.slice(0, 300),
    })
    .where(rowOf(task, model))
    .run();
  return resting;
}
