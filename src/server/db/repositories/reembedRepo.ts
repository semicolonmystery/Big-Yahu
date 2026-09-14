import { and, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { reembedJobItems, reembedJobs } from '../schema';

export type ReembedStatus = 'running' | 'failed' | 'complete';

export interface ReembedJob {
  id: number;
  sourceModel: string;
  sourceDimensions: number;
  sourceCollection: string;
  targetModel: string;
  targetDimensions: number;
  targetCollection: string;
  total: number;
  copied: number;
  status: string;
  lastError: string | null;
  pausesRecall: boolean;
  startedAt: number;
  finishedAt: number | null;
}

/** The one job that is still going, if any. Only ever one at a time. */
export function openJob(): ReembedJob | undefined {
  return db.select().from(reembedJobs).where(eq(reembedJobs.status, 'running')).get();
}

export function latestJob(): ReembedJob | undefined {
  return db.select().from(reembedJobs).orderBy(sql`${reembedJobs.id} desc`).limit(1).get();
}

export function jobById(id: number): ReembedJob | undefined {
  return db.select().from(reembedJobs).where(eq(reembedJobs.id, id)).get();
}

/**
 * Opens a job and writes its snapshot in one transaction, so a crash between
 * the two cannot leave a job that has promised to move an unknown set of facts.
 */
export function createJob(
  values: Omit<ReembedJob, 'id' | 'copied' | 'status' | 'lastError' | 'startedAt' | 'finishedAt' | 'total'>,
  factIds: string[],
): ReembedJob {
  return db.transaction((tx) => {
    const job = tx
      .insert(reembedJobs)
      .values({ ...values, total: factIds.length, copied: 0, status: 'running', startedAt: Date.now() })
      .returning()
      .get();
    // SQLite caps how many variables one statement may bind.
    for (let at = 0; at < factIds.length; at += 500) {
      tx.insert(reembedJobItems)
        .values(factIds.slice(at, at + 500).map((factId) => ({ jobId: job.id, factId })))
        .run();
    }
    return job;
  });
}

export function pendingFactIds(jobId: number, limit: number): string[] {
  return db
    .select({ factId: reembedJobItems.factId })
    .from(reembedJobItems)
    .where(and(eq(reembedJobItems.jobId, jobId), eq(reembedJobItems.copied, false)))
    .limit(limit)
    .all()
    .map((row) => row.factId);
}

/** One transaction per batch: the cursor and the count can never disagree. */
export function markCopied(jobId: number, factIds: string[]): void {
  if (factIds.length === 0) return;
  db.transaction((tx) => {
    for (const factId of factIds) {
      tx.update(reembedJobItems)
        .set({ copied: true })
        .where(and(eq(reembedJobItems.jobId, jobId), eq(reembedJobItems.factId, factId)))
        .run();
    }
    tx.update(reembedJobs)
      .set({ copied: sql`${reembedJobs.copied} + ${factIds.length}` })
      .where(eq(reembedJobs.id, jobId))
      .run();
  });
}

/**
 * A fact deleted while a job is open must not come back when its batch is
 * copied, so it leaves the snapshot rather than the snapshot being re-taken.
 */
export function dropFromSnapshot(factId: string): void {
  const job = openJob();
  if (!job) return;
  const removed = db
    .delete(reembedJobItems)
    .where(and(eq(reembedJobItems.jobId, job.id), eq(reembedJobItems.factId, factId), eq(reembedJobItems.copied, false)))
    .run();
  if (removed.changes > 0) {
    db.update(reembedJobs).set({ total: sql`${reembedJobs.total} - 1` }).where(eq(reembedJobs.id, job.id)).run();
  }
}

/** True while there is nothing worth recalling from yet. */
export function recallIsPaused(): boolean {
  return openJob()?.pausesRecall ?? false;
}

/**
 * Keeps a job's promise current when the store changes under it.
 *
 * A fact written or rewritten while a job is running is in the source and not
 * in the target, so it joins the snapshot — and one already copied goes back in
 * the queue, because what was copied is now the old wording. Without this, every
 * fact saved during a long job would be dropped by the swap.
 */
export function noteFactsChanged(collection: string, factIds: string[]): void {
  const job = openJob();
  if (!job || job.sourceCollection !== collection || factIds.length === 0) return;
  db.transaction((tx) => {
    let added = 0;
    let uncopied = 0;
    for (const factId of factIds) {
      const existing = tx
        .select()
        .from(reembedJobItems)
        .where(and(eq(reembedJobItems.jobId, job.id), eq(reembedJobItems.factId, factId)))
        .get();
      if (!existing) {
        tx.insert(reembedJobItems).values({ jobId: job.id, factId }).run();
        added += 1;
      } else if (existing.copied) {
        tx.update(reembedJobItems)
          .set({ copied: false })
          .where(and(eq(reembedJobItems.jobId, job.id), eq(reembedJobItems.factId, factId)))
          .run();
        uncopied += 1;
      }
    }
    if (added > 0 || uncopied > 0) {
      tx.update(reembedJobs)
        .set({
          total: sql`${reembedJobs.total} + ${added}`,
          copied: sql`${reembedJobs.copied} - ${uncopied}`,
        })
        .where(eq(reembedJobs.id, job.id))
        .run();
    }
  });
}

export function finishJob(jobId: number, status: ReembedStatus, lastError?: string): void {
  db.update(reembedJobs)
    .set({ status, lastError: lastError ?? null, finishedAt: Date.now() })
    .where(eq(reembedJobs.id, jobId))
    .run();
}

/** A failed job is picked up again rather than restarted, keeping what it copied. */
export function resumeJob(jobId: number): void {
  db.update(reembedJobs).set({ status: 'running', lastError: null, finishedAt: null }).where(eq(reembedJobs.id, jobId)).run();
}

export function forgetJobs(): void {
  db.delete(reembedJobItems).run();
  db.delete(reembedJobs).run();
}
