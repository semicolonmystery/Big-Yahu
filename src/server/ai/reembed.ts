import { chroma, collectionFor, collectionNameFor, forgetCollections } from '../db/chroma';
import { configuredEmbedding, embedWith, type EmbeddingConfig } from './embeddings';
import { embeddingText } from '../db/repositories/factsRepo';
import { getActiveEmbedding, setActiveEmbedding } from '../db/repositories/settingsRepo';
import {
  createJob, finishJob, jobById, openJob, markCopied, pendingFactIds, resumeJob, type ReembedJob,
} from '../db/repositories/reembedRepo';
import { LEGACY_EMBEDDING_DIMENSIONS, LEGACY_EMBEDDING_MODEL, LEGACY_FACTS_COLLECTION } from '@shared/constants';

/** Small enough that a failure costs little, large enough not to be chatty. */
const BATCH = 50;

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

export async function startReembed(): Promise<ReembedJob | null> {
  const running = openJob();
  if (running) return running;

  const plan = await planReembed();
  if (plan.upToDate || !plan.source.exists) {
    // Nothing to move. Say so by pointing recall at the configured pair, so the
    // panel stops offering a job that would copy nothing.
    setActiveEmbedding(plan.target.model, plan.target.dimensions);
    forgetCollections();
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

  setActiveEmbedding(job.targetModel, job.targetDimensions);
  forgetCollections();
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

let running: Promise<void> | null = null;

/** Drives the open job to the end. Safe to call again; it will not double-run. */
export function runReembed(): Promise<void> {
  if (running) return running;
  running = drive().finally(() => { running = null; });
  return running;
}

async function drive(): Promise<void> {
  let job = openJob();
  while (job) {
    const ids = pendingFactIds(job.id, BATCH);
    if (ids.length === 0) {
      await completeJob(job);
      return;
    }
    try {
      await copyBatch(job, ids);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishJob(job.id, 'failed', message);
      console.error('[reembed] paused after a failure; it resumes from where it stopped:', error);
      return;
    }
    const next = jobById(job.id);
    console.log(`[reembed] ${next?.copied ?? 0}/${next?.total ?? 0} facts moved`);
    job = openJob();
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
    console.log(`[reembed] resuming job ${open.id} at ${open.copied}/${open.total}`);
    void runReembed();
    return;
  }
  const plan = await planReembed();
  if (plan.upToDate) return;
  if (!plan.source.exists || plan.source.facts === 0) {
    setActiveEmbedding(plan.target.model, plan.target.dimensions);
    forgetCollections();
    return;
  }
  console.log(`[reembed] ${plan.source.facts} fact(s) are still embedded with ${plan.source.model}`);
  await startReembed();
  void runReembed();
}

export { resumeJob };
