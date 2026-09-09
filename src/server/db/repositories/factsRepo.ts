import { randomUUID } from 'node:crypto';
import type { Metadata } from 'chromadb';
import { getFactsCollection } from '../chroma';
import { getSettings } from './settingsRepo';
import { embedDocuments, embedQuery } from '../../ai/embeddings';
import { rewriteForFactSearch } from '../../ai/queryRewrite';
import { hasUnresolvedRelativeDate, resolveRelativeDates } from '../../ai/dateEnforcement';
import { mentionedUserIds } from '@shared/discord';
import { getAIRequestSignal } from '../../ai/requestBudget';

import type { Fact, FactMetadata } from '@shared/types';

export interface FactCandidate {
  text: string;
  messageIds: string[];
  authorIds?: string[];
  guildId: string;
  channelId: string;
  referencedFactIds?: string[];
  source: 'auto' | 'reply';
  timePeriodStart: number;
  timePeriodEnd: number;
}

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

const normalise = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

// Replies, periodic extraction, plugins and admin deletions share this store.
// A failed operation must not poison the queue for the next caller.
let mutationTail: Promise<unknown> = Promise.resolve();

function mutateFacts<T>(run: () => Promise<T>): Promise<T> {
  const signal = getAIRequestSignal();
  const result = mutationTail.then(() => {
    // An expired reply must never perform its queued write later.
    signal?.throwIfAborted();
    return run();
  });
  mutationTail = result.catch(() => undefined);
  if (!signal) return result;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
    result.then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value); },
      (error) => { signal.removeEventListener('abort', aborted); reject(error); },
    );
  });
}

function metadataFor(candidate: FactCandidate, previous?: Fact, identical = false): Metadata {
  const metadata: Metadata = {
    guildId: candidate.guildId,
    channelId: identical && previous ? previous.metadata.channelId : candidate.channelId,
    source: identical && previous ? previous.metadata.source : candidate.source,
    createdAt: identical && previous ? previous.metadata.createdAt : Date.now(),
    timePeriodStart: Math.min(candidate.timePeriodStart, previous?.metadata.timePeriodStart ?? candidate.timePeriodStart),
    timePeriodEnd: Math.max(candidate.timePeriodEnd, previous?.metadata.timePeriodEnd ?? candidate.timePeriodEnd),
  };
  for (const key of ['messageIds', 'authorIds', 'referencedFactIds'] as const) {
    const merged = [...new Set([
      ...(previous?.metadata[key] ?? []), ...(candidate[key] ?? []),
      ...(key === 'authorIds' ? mentionedUserIds(candidate.text) : []),
    ])];
    // Chroma rejects empty metadata arrays.
    if (merged.length > 0) metadata[key] = merged;
  }
  return metadata;
}

function sameSubjects(first: string, second: string): boolean {
  const firstIds = new Set(mentionedUserIds(first));
  const secondIds = mentionedUserIds(second);
  return firstIds.size === secondIds.length && secondIds.every((id) => firstIds.has(id));
}

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
  const pending = candidates.filter((candidate) => candidate.text.trim()).map((candidate) => ({ ...candidate }));
  if (pending.length === 0) return [];
  await enforceAbsoluteDates(pending);
  // Finish embedding before touching existing records. In particular, an outage
  // must never remove the old wording of a fact being replaced.
  const embeddings = await embedDocuments(pending.map((candidate) => candidate.text));

  return mutateFacts(async () => {
    const threshold = getSettings().duplicateDistance / 100;
    const collection = await getFactsCollection();
    const savedIds = new Set<string>();

    for (const [index, candidate] of pending.entries()) {
      // Source overlap alone proves nothing: one message can contain several
      // independent facts. Each completed write is visible to the next candidate.
      const [nearest] = await searchFacts(candidate.text, 1, { guildId: candidate.guildId }, { rewrite: false });
      const identical = nearest && normalise(nearest.text) === normalise(candidate.text);
      // Similar sentences about different people are independent facts, not
      // updates to each other. Source authors are not a substitute for subjects.
      if (nearest && (identical || (nearest.distance !== null && nearest.distance < threshold
        && sameSubjects(nearest.text, candidate.text)))) {
        await collection.update({
          ids: [nearest.id],
          metadatas: [metadataFor(candidate, nearest, identical)],
          ...(!identical ? { documents: [candidate.text], embeddings: [embeddings[index]] } : {}),
        });
        if (!identical) {
          // Updating one record keeps its ID and references intact. There is no
          // delete-before-add gap, even if the request fails or the process exits.
          savedIds.add(nearest.id);
          console.log(`[facts] updated ${nearest.id}: ${nearest.text.slice(0, 60)}`);
        }
        continue;
      }

      const id = randomUUID();
      await collection.add({
        ids: [id], documents: [candidate.text], embeddings: [embeddings[index]], metadatas: [metadataFor(candidate)],
      });
      savedIds.add(id);
    }
    return [...savedIds];
  });
}

export async function deleteFact(id: string): Promise<boolean> {
  return mutateFacts(async () => {
    const collection = await getFactsCollection();
    const existing = await collection.get({ ids: [id] });
    if (existing.ids.length === 0) return false;
    await collection.delete({ ids: [id] });
    return true;
  });
}

/**
 * Facts newest first, optionally narrowed to one person. Chroma cannot order
 * `get` by createdAt, so the collection is sorted and paged here; the fact store
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
