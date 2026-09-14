import { chroma, collectionFor, collectionNameFor, forgetCollections } from '../db/chroma';
import { configuredEmbedding, embedWith, type EmbeddingConfig } from './embeddings';
import { embeddingText } from '../db/repositories/factsRepo';
import { getActiveEmbedding, setActiveEmbedding } from '../db/repositories/settingsRepo';
import {
  copiedFactIds, createJob, deleteJob, finishJob, jobById, markCopied, openJob, pauseJob, pendingFactIds,
  resumeJob, runningJob, type ReembedJob,
} from '../db/repositories/reembedRepo';
import { cleanupBatch } from './factCleanup';
import { LEGACY_EMBEDDING_DIMENSIONS, LEGACY_EMBEDDING_MODEL, LEGACY_FACTS_COLLECTION } from '@shared/constants';

/** Small enough that a failure costs little, large enough not to be chatty. */
const BATCH = 50;

/** The copy loop, while one is in flight, so nothing runs it twice or acts mid-batch. */
let running: Promise<void> | null = null;

/**
 * Where the facts are now.
 *
 * Before any re-embed has run, the store is the collection that predates
 * per-model names — the one the old provider filled. After one, it is whatever
 * the last completed job swapped to.
 */
export function currentSource(): { config: EmbeddingConfig; collection: string } {
  const active = getActiveEmbedding();
  if (!active.model || active.dimensions <= 0) {
    return {
      config: { model: LEGACY_EMBEDDING_MODEL, dimensions: LEGACY_EMBEDDING_DIMENSIONS },
      collection: LEGACY_FACTS_COLLECTION,
    };
  }
  return { config: active, collection: collectionNameFor(active) };
}

async function collectionExists(name: string): Promise<boolean> {
  const collections = await chroma.listCollections();
  return collections.some((entry) => (typeof entry === 'string' ? entry : entry.name) === name);
}

/** Every id in a collection, paged, because a snapshot has to be the whole thing. */
async function allIds(name: string): Promise<string[]> {
  // Read-only, and never queried or added to, so it needs no embedding function
  // — which matters here: the model that filled it may no longer be reachable.
  const collection = await chroma.getCollection({ name });
  const ids: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await collection.get({ limit: 1000, offset, include: [] });
    ids.push(...page.ids);
    if (page.ids.length < 1000) return ids;
  }
}

export interface ReembedPlan {
  /** Nothing to do: the store already matches what is configured. */
  upToDate: boolean;
  source: { model: string; dimensions: number; collection: string; exists: boolean; facts: number };
  target: { model: string; dimensions: number; collection: string };
}

/** What a re-embed would move, for the panel to show before anything is spent. */
export async function planReembed(): Promise<ReembedPlan> {
  const source = currentSource();
  const target = configuredEmbedding();
  const exists = await collectionExists(source.collection);
  const facts = exists ? await (await chroma.getCollection({ name: source.collection })).count() : 0;
  return {
    upToDate: collectionNameFor(target) === source.collection,
    source: { ...source.config, collection: source.collection, exists, facts },
    target: { ...target, collection: collectionNameFor(target) },
  };
}

/**
 * Opens a job. Only ever called because somebody pressed the button: a re-embed
 * is long and paid, and starting one off the back of a settings change would
 * spend an operator's money on a decision they had not made yet.
 */
export async function startReembed(): Promise<ReembedJob | null> {
  const existing = openJob();
  if (existing) return existing;

  const plan = await planReembed();
  if (plan.upToDate || !plan.source.exists || plan.source.facts === 0) {
    // Nothing to move, so there is nothing to decide: point recall at the
    // configured pair and let the panel stop offering a job that copies nothing.
    adopt(plan.target.model, plan.target.dimensions);
    return null;
  }

  const ids = await allIds(plan.source.collection);
  const job = createJob({
    sourceModel: plan.source.model,
    sourceDimensions: plan.source.dimensions,
    sourceCollection: plan.source.collection,
    targetModel: plan.target.model,
    targetDimensions: plan.target.dimensions,
    targetCollection: plan.target.collection,
    // Recall has nothing to read until the first migration lands, so it waits
    // rather than answering out of a collection that is still filling.
    pausesRecall: !getActiveEmbedding().model,
  }, ids);
  console.log(`[reembed] moving ${ids.length} fact(s) from ${plan.source.collection} to ${plan.target.collection}`);
  return job;
}

function adopt(model: string, dimensions: number): void {
  setActiveEmbedding(model, dimensions);
  forgetCollections();
}

/** Stops at the next batch boundary. What is copied stays copied. */
export function pauseReembed(): boolean {
  const job = openJob();
  if (!job || job.status !== 'running') return false;
  pauseJob(job.id);
  console.log(`[reembed] paused at ${job.copied}/${job.total}`);
  return true;
}

/** Picks a paused or failed job back up from its cursor. */
export function continueReembed(): boolean {
  const job = openJob();
  if (!job || job.status === 'running') return false;
  resumeJob(job.id);
  void runReembed();
  return true;
}

/**
 * Throws the move away and leaves the facts as they were.
 *
 * Only what this job put in the target is removed, by id, rather than the whole
 * collection: during the first move the target is also where new facts are being
 * written, and dropping it would take those with it. The source is never touched
 * — it is still the only copy.
 */
export async function resetReembed(): Promise<boolean> {
  const job = openJob();
  if (!job) return false;
  if (job.status === 'running') pauseJob(job.id);
  await running;

  const copied = copiedFactIds(job.id);
  // A cleanup writes in place, so source and target are the same collection and
  // there is nothing to take back: the facts it rewrote were improved, and
  // reverting them would mean keeping the old wording it had just corrected.
  // Reset abandons the rest of the run instead, and running it again is safe.
  if (copied.length > 0 && job.sourceCollection !== job.targetCollection) {
    const target = await collectionFor({ model: job.targetModel, dimensions: job.targetDimensions });
    for (let at = 0; at < copied.length; at += 200) {
      await target.delete({ ids: copied.slice(at, at + 200) });
    }
  }
  deleteJob(job.id);
  console.log(`[reembed] reset; ${copied.length} copied fact(s) removed from ${job.targetCollection}`);
  return true;
}

async function copyBatch(job: ReembedJob, ids: string[]): Promise<void> {
  const source = await chroma.getCollection({ name: job.sourceCollection });
  const target = await collectionFor({ model: job.targetModel, dimensions: job.targetDimensions });

  const rows = (await source.get({ ids, include: ['documents', 'metadatas'] })).rows();
  // Ids that vanished between the snapshot and now are done, not stuck.
  const present = rows.filter((row) => (row.document ?? '').trim().length > 0);
  if (present.length > 0) {
    const embeddings = await embedWith(
      present.map((row) => embeddingText(row.document ?? '')),
      { model: job.targetModel, dimensions: job.targetDimensions },
    );
    await target.upsert({
      ids: present.map((row) => row.id),
      documents: present.map((row) => row.document ?? ''),
      metadatas: present.map((row) => (row.metadata ?? {}) as never),
      embeddings,
    });
  }
  markCopied(job.id, ids);
}

/**
 * Finishes only once every promised fact is across, then points recall at the
 * new collection and drops the old one. The check is the point: the source is
 * deleted right after, so "complete" has to mean complete.
 */
async function completeJob(job: ReembedJob): Promise<void> {
  const target = await collectionFor({ model: job.targetModel, dimensions: job.targetDimensions });

  // Checked against the source as it stands now, id by id, rather than against
  // the job's own counters. The source is deleted a few lines below, so this is
  // the last moment anything can notice a fact that did not make it, and a
  // count would not: two collections can hold the same number of different
  // facts. Anything deleted meanwhile is simply gone from both.
  const expected = await allIds(job.sourceCollection);
  const missing: string[] = [];
  for (let at = 0; at < expected.length; at += 200) {
    const slice = expected.slice(at, at + 200);
    const present = new Set((await target.get({ ids: slice, include: [] })).ids);
    missing.push(...slice.filter((id) => !present.has(id)));
    if (missing.length > 0) break;
  }
  if (missing.length > 0) {
    const reason = `${missing.length} fact(s) did not reach ${job.targetCollection}, starting with ${missing[0]}`;
    finishJob(job.id, 'failed', reason);
    console.error(`[reembed] refusing to swap and keeping ${job.sourceCollection}: ${reason}`);
    return;
  }
  const moved = await target.count();

  adopt(job.targetModel, job.targetDimensions);
  finishJob(job.id, 'complete');
  console.log(`[reembed] ${job.targetCollection} is live with ${moved} fact(s)`);

  if (job.sourceCollection !== job.targetCollection) {
    try {
      await chroma.deleteCollection({ name: job.sourceCollection });
      console.log(`[reembed] removed the old collection ${job.sourceCollection}`);
    } catch (error) {
      // The swap already happened and is what matters; a leftover collection
      // costs disk, not correctness.
      console.warn(`[reembed] could not remove ${job.sourceCollection}:`, error);
    }
  }
}

/** Drives the open job to the end. Safe to call again; it will not double-run. */
export function runReembed(): Promise<void> {
  if (running) return running;
  running = drive().finally(() => { running = null; });
  return running;
}

/**
 * Drives whichever job is open to the end.
 *
 * Both kinds are the same loop — take the next batch of promised ids, do the
 * work, checkpoint, and re-read the row so a pause lands at the boundary. What
 * differs is the batch body and what finishing means: a re-embed verifies
 * everything is across and swaps collections, while a cleanup has been writing
 * in place all along and is simply done.
 */
async function drive(): Promise<void> {
  let job = runningJob();
  while (job) {
    const cleanup = job.kind === 'cleanup';
    const label = cleanup ? 'cleanup' : 'reembed';
    const ids = pendingFactIds(job.id, cleanup ? job.bundleSize || BATCH : BATCH);
    if (ids.length === 0) {
      if (cleanup) {
        finishJob(job.id, 'complete');
        console.log(`[cleanup] done; ${job.copied} fact(s) went past the model`);
      } else {
        await completeJob(job);
      }
      return;
    }
    try {
      await (cleanup ? cleanupBatch(job, ids) : copyBatch(job, ids));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishJob(job.id, 'failed', message);
      console.error(`[${label}] paused after a failure; it resumes from where it stopped:`, error);
      return;
    }
    const next = jobById(job.id);
    console.log(`[${label}] ${next?.copied ?? 0}/${next?.total ?? 0} facts ${cleanup ? 'looked at' : 'moved'}`);
    // Re-read rather than loop on the old row: a pause arriving mid-batch is
    // honoured here, at the boundary, so nothing is left half-written.
    job = runningJob();
  }
}

/**
 * Picks up a job left open by a restart, and starts the first migration.
 *
 * Never throws: an unreachable fact store is a reason for the bot to come up
 * without its memory and say so, not a reason for it not to come up.
 */
export async function resumeReembedAtBoot(): Promise<void> {
  try {
    await resumeOrStart();
  } catch (error) {
    console.warn('[reembed] could not check the fact store at boot:', error);
  }
}

async function resumeOrStart(): Promise<void> {
  const open = openJob();
  if (open) {
    // A job the operator started and did not pause carries on; a paused or
    // failed one waits for them, because a restart is not consent to spend.
    const label = open.kind === 'cleanup' ? 'cleanup' : 'reembed';
    if (open.status === 'running') {
      console.log(`[${label}] continuing job ${open.id} at ${open.copied}/${open.total}`);
      void runReembed();
    } else {
      console.log(`[${label}] job ${open.id} is ${open.status} at ${open.copied}/${open.total}; waiting for the panel`);
    }
    return;
  }

  const plan = await planReembed();
  if (plan.upToDate) return;
  if (!plan.source.exists || plan.source.facts === 0) {
    // An empty store has nothing to migrate, so settle the names and move on.
    adopt(plan.target.model, plan.target.dimensions);
    return;
  }
  // Deliberately not started. It costs money and takes a while; the panel says
  // it is waiting and the operator decides when.
  console.log(`[reembed] ${plan.source.facts} fact(s) are still embedded with ${plan.source.model}`
    + ' — press Re-embed in Settings to move them');
}

