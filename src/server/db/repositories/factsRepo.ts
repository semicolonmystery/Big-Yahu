import { randomUUID } from 'node:crypto';
import type { Metadata } from 'chromadb';
import { getFactsCollection } from '../chroma';
import { getSettings } from './settingsRepo';
import { embedDocuments, embedQuery } from '../../ai/embeddings';
import { rewriteForFactSearch } from '../../ai/queryRewrite';
import { hasUnresolvedRelativeDate, resolveRelativeDates } from '../../ai/dateEnforcement';

import type { Fact, FactMetadata } from '@shared/types';
import type { FactCandidate } from '@big-yahu/plugin-sdk';

/**
 * Defined by the plugin SDK, because `saveFacts` on the plugin context takes
 * one and a plugin cannot import from in here. Re-exported so everything in the
 * bot keeps importing it from the repository that writes them.
 */
export type { FactCandidate } from '@big-yahu/plugin-sdk';

function toFact(id: string, document: string | null | undefined, metadata: Metadata | null | undefined): Fact {
  const meta = (metadata ?? {}) as unknown as FactMetadata;
  return {
    id,
    text: document ?? '',
    metadata: {
      guildId: meta.guildId ?? '',
      channelId: meta.channelId ?? '',
      messageIds: meta.messageIds ?? [],
      authorIds: meta.authorIds ?? [],
      referencedFactIds: meta.referencedFactIds ?? [],
      timePeriodStart: meta.timePeriodStart ?? 0,
      timePeriodEnd: meta.timePeriodEnd ?? 0,
      source: meta.source ?? 'auto',
      createdAt: meta.createdAt ?? 0,
    },
  };
}

export async function countFacts(): Promise<number> {
  const collection = await getFactsCollection();
  return collection.count();
}

export async function listAllFacts(): Promise<Fact[]> {
  const collection = await getFactsCollection();
  const result = await collection.get({ include: ['documents', 'metadatas'] });
  return result.rows().map((row) => toFact(row.id, row.document, row.metadata));
}

export async function searchFacts(
  queryText: string,
  topK: number,
  where?: Record<string, unknown>,
  options?: { rewrite?: boolean },
): Promise<Array<Fact & { distance: number | null }>> {
  const collection = await getFactsCollection();
  const searchText = options?.rewrite === false ? queryText : await rewriteForFactSearch(queryText);
  const queryEmbedding = await embedQuery(searchText);
  const result = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: topK,
    where: where as never,
    include: ['documents', 'metadatas', 'distances'],
  });
  const rows = result.rows()[0] ?? [];
  return rows.map((row) => ({
    ...toFact(row.id, row.document, row.metadata),
    distance: row.distance ?? null,
  }));
}

/**
 * A candidate whose source messages are already fully covered by an existing
 * fact in the same channel is a re-extraction of ground already walked.
 */
async function findMessageSupersetFact(candidate: FactCandidate): Promise<Fact | undefined> {
  // A candidate citing no messages is covered by nothing. `every` on an empty
  // array is vacuously true, so without this it matches the first fact in the
  // channel and is silently dropped — which is what a fact promoted out of a
  // rolling memory can look like.
  if (candidate.messageIds.length === 0) return undefined;

  const collection = await getFactsCollection();
  const existing = await collection.get({
    where: { channelId: candidate.channelId } as never,
    include: ['documents', 'metadatas'],
  });
  return existing
    .rows()
    .map((row) => toFact(row.id, row.document, row.metadata))
    .find((fact) => {
      const covered = new Set(fact.metadata.messageIds);
      return candidate.messageIds.every((id) => covered.has(id));
    });
}

async function mergeMessageIds(fact: Fact, messageIds: string[]): Promise<void> {
  const merged = [...new Set([...fact.metadata.messageIds, ...messageIds])];
  if (merged.length === fact.metadata.messageIds.length) return;

  const collection = await getFactsCollection();
  const meta = { ...fact.metadata, messageIds: merged } as any;
  if (meta.referencedFactIds && meta.referencedFactIds.length === 0) {
    delete meta.referencedFactIds;
  }
  if (meta.messageIds && meta.messageIds.length === 0) {
    delete meta.messageIds;
  }

  await collection.update({
    ids: [fact.id],
    metadatas: [meta as Metadata],
  });
}

const normalise = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Inserts facts that are genuinely new. A candidate close enough to an existing
 * fact either replaces it — the newer wording is the more current one, and the
 * old entry is deleted so the pair cannot both come back later — or is dropped
 * when it says exactly the same thing. Returns the ids actually created.
 */
/**
 * Both write paths are only *asked* to resolve "tomorrow" into a real date, and
 * asking has never been enough — the same lesson as `<@id>` mentions. This is
 * the single choke point where it can be enforced, and it runs before the dedupe
 * loop below so the stored text, the embedding and the similarity comparison all
 * see the same corrected wording.
 *
 * A candidate that still reads as relative afterwards is stored and named in the
 * log rather than dropped: losing a real fact is worse than a fuzzy date.
 */
async function enforceAbsoluteDates(candidates: FactCandidate[]): Promise<void> {
  const offending = candidates.filter((candidate) => hasUnresolvedRelativeDate(candidate.text));
  if (offending.length === 0) return;

  // The end of the fact's own time period is what "tomorrow" was said relative to.
  const resolved = await resolveRelativeDates(
    offending.map((candidate) => ({ text: candidate.text, anchor: candidate.timePeriodEnd })),
  );

  offending.forEach((candidate, position) => {
    const text = resolved[position];
    if (text && text !== candidate.text) {
      console.log(`[facts] resolved a relative date: "${candidate.text.slice(0, 60)}" -> "${text.slice(0, 60)}"`);
      candidate.text = text;
    }
    if (hasUnresolvedRelativeDate(candidate.text)) {
      console.warn(`[facts] storing a fact that still reads as relative: ${candidate.text.slice(0, 120)}`);
    }
  });
}

export async function addFacts(candidates: FactCandidate[]): Promise<string[]> {
  if (candidates.length === 0) return [];

  await enforceAbsoluteDates(candidates);

  const threshold = getSettings().duplicateDistance / 100;
  const accepted: FactCandidate[] = [];

  for (const candidate of candidates) {
    if (!candidate.text.trim()) continue;

    const superset = await findMessageSupersetFact(candidate);
    if (superset) continue;

    // Compared without the rewrite: this is fact-against-fact, already the right shape.
    const [nearest] = await searchFacts(candidate.text, 1, { guildId: candidate.guildId }, { rewrite: false });
    if (nearest && nearest.distance !== null && nearest.distance < threshold) {
      if (normalise(nearest.text) === normalise(candidate.text)) {
        await mergeMessageIds(nearest, candidate.messageIds);
        continue;
      }
      // Supersede: carry the old fact's sources forward, then drop it.
      candidate.messageIds = [...new Set([...nearest.metadata.messageIds, ...candidate.messageIds])];
      candidate.authorIds = [...new Set([...nearest.metadata.authorIds, ...(candidate.authorIds ?? [])])];
      await deleteFact(nearest.id);
      console.log(`[facts] superseded ${nearest.id}: ${nearest.text.slice(0, 60)}`);
    }
    accepted.push(candidate);
  }

  if (accepted.length === 0) return [];

  const now = Date.now();
  const ids = accepted.map(() => randomUUID());
  const documents = accepted.map((candidate) => candidate.text);
  const embeddings = await embedDocuments(documents);
  const metadatas = accepted.map(
    (candidate): Metadata => {
      const meta: any = {
        guildId: candidate.guildId,
        channelId: candidate.channelId,
        timePeriodStart: candidate.timePeriodStart,
        timePeriodEnd: candidate.timePeriodEnd,
        source: candidate.source,
        createdAt: now,
      };
      if (candidate.messageIds && candidate.messageIds.length > 0) {
        meta.messageIds = candidate.messageIds;
      }
      if (candidate.authorIds && candidate.authorIds.length > 0) {
        meta.authorIds = candidate.authorIds;
      }
      if (candidate.referencedFactIds && candidate.referencedFactIds.length > 0) {
        meta.referencedFactIds = candidate.referencedFactIds;
      }
      return meta as Metadata;
    }
  );

  const collection = await getFactsCollection();
  await collection.add({ ids, documents, embeddings, metadatas });
  return ids;
}

export async function deleteFact(id: string): Promise<boolean> {
  const collection = await getFactsCollection();
  const existing = await collection.get({ ids: [id] });
  if (existing.ids.length === 0) return false;
  await collection.delete({ ids: [id] });
  return true;
}

/**
 * Facts newest first, optionally narrowed to one person. Chroma has no ordering
 * or offset on `get`, so the collection is read and paged here; the fact store
 * is small enough for that to be the simpler trade.
 */
export async function listFactsPage(options: {
  page: number;
  pageSize: number;
  authorId?: string;
}): Promise<{ facts: Fact[]; total: number }> {
  const all = await listAllFacts();
  const filtered = options.authorId
    ? all.filter((fact) => fact.metadata.authorIds.includes(options.authorId!))
    : all;
  const sorted = filtered.sort((a, b) => b.metadata.createdAt - a.metadata.createdAt);
  const start = (options.page - 1) * options.pageSize;
  return { facts: sorted.slice(start, start + options.pageSize), total: sorted.length };
}
