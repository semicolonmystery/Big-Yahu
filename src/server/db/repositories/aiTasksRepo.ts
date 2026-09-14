import { eq } from 'drizzle-orm';
import { db } from '../client';
import { aiTasks } from '../schema';
import { REASONING_EFFORTS, type ReasoningEffort } from '@shared/aiTasks';

const isEffort = (value: string): value is ReasoningEffort => (REASONING_EFFORTS as readonly string[]).includes(value);

/** No row, or anything unrecognised in one, means no reasoning — the cheap and fast default. */
export function reasoningEffortFor(task: string): ReasoningEffort {
  const row = db.select().from(aiTasks).where(eq(aiTasks.task, task)).get();
  return row && isEffort(row.reasoningEffort) ? row.reasoningEffort : 'none';
}

export function setReasoningEffort(task: string, effort: ReasoningEffort): void {
  const updatedAt = Date.now();
  db.insert(aiTasks)
    .values({ task, reasoningEffort: effort, updatedAt })
    .onConflictDoUpdate({ target: aiTasks.task, set: { reasoningEffort: effort, updatedAt } })
    .run();
}
