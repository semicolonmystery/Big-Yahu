import { randomUUID } from 'node:crypto';
import type { Metadata } from 'chromadb';
import { collectionNameFor, getFactsCollection } from '../chroma';
import { activeEmbedding } from '../../ai/embeddings';
import { getSettings } from './settingsRepo';
import { dropFromSnapshot, noteFactsChanged, recallIsPaused } from './reembedRepo';
import { embedDocuments, embedQuery } from '../../ai/embeddings';
import { hasUnresolvedRelativeDate, resolveRelativeDates } from '../../ai/dateEnforcement';
import { mentionedUserIds } from '@shared/discord';
import { getAIRequestSignal } from '../../ai/requestBudget';

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
      subjectIds: meta.subjectIds ?? [],
      channelRefs: meta.channelRefs ?? [],
      ...(meta.dateMin !== undefined ? { dateMin: meta.dateMin } : {}),
      ...(meta.dateMax !== undefined ? { dateMax: meta.dateMax } : {}),
      referencedFactIds: meta.referencedFactIds ?? [],
      timePeriodStart: meta.timePeriodStart ?? 0,
      timePeriodEnd: meta.timePeriodEnd ?? 0,
      source: meta.source ?? 'auto',
      createdAt: meta.createdAt ?? 0,
    },
  };
}

/** Everyone a fact concerns: whose messages it came from, and who it is about. */
export function peopleIn(fact: Fact): string[] {
  return [...new Set([...fact.metadata.authorIds, ...(fact.metadata.subjectIds ?? [])])];
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

const MENTION_PATTERN = /<@!?(\d+)>/g;
const CHANNEL_PATTERN = /<#(\d+)>/g;
/** Dates in stored facts are always day.month.year, which is what makes this exact rather than a guess. */
const DATE_PATTERN = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since the epoch, so a range check is two integers rather than date arithmetic in a query. */
function epochDay(day: number, month: number, year: number): number | null {
  const at = Date.UTC(year, month - 1, day);
  return Number.isFinite(at) ? Math.floor(at / DAY_MS) : null;
}

export function datesIn(text: string): number[] {
  const days: number[] = [];
  for (const [, day, month, year] of text.matchAll(DATE_PATTERN)) {
    const value = epochDay(Number(day), Number(month), Number(year));
    if (value !== null) days.push(value);
  }
  return days;
}

export function channelIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(CHANNEL_PATTERN)].map((match) => match[1]))];
}

/**
 * What actually goes to the embedding model.
 *
 * An embedding captures meaning, and an id has none: "<@1049…>" is a handful of
 * digits that crowd out the sentence around them, and a date is worse, because
 * two unrelated facts from the same afternoon look alike. Both are matched
 * exactly, through metadata, so they are taken out of the text being embedded
 * rather than competing with it. The stored fact keeps them: the model reading
 * it needs them.
 */
export function embeddingText(text: string): string {
  return text
    .replace(MENTION_PATTERN, 'someone')
    .replace(CHANNEL_PATTERN, 'a channel')
    .replace(DATE_PATTERN, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** How much a person or date match lifts a result. Cosine distances here sit well under 1. */
const FACET_BONUS = 0.05;
/** Asking about more people than this is not a question, it is a roster. */
const MAX_PEOPLE = 5;
/** At least this many facet matches survive the cut when there are any. */
const KEEP_FACET_MATCHES = 2;

export interface RecallOptions {
  /** Written the way a stored fact is written — the topic call and the lookup tools both ask for that. */
  query: string;
  topK: number;
  guildId?: string;
  /** Discord ids the question is about. */
  people?: string[];
  channels?: string[];
  /** day.month.year, as the model writes dates everywhere else. */
  dateFrom?: string;
  dateTo?: string;
  /** An extra Chroma filter, such as one channel. */
  where?: Record<string, unknown>;
  /** Overrides the configured ceiling, as a distance rather than hundredths. */
  maxDistance?: number;
}

function bothOf(base: Record<string, unknown> | undefined, extra: Record<string, unknown>): Record<string, unknown> {
  return base ? { $and: [base, extra] } : extra;
}

function readDay(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
  return match ? epochDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/**
 * Finds what the bot remembers about something.
 *
 * One embedding, several searches: the plain one, and one per thing the question
 * is actually about — a person, a channel, a span of days. A match on any of
 * those lifts a fact up the list; it never filters one out, so a relevant fact
 * that happens to name nobody is still found. Facts carry who they are about,
 * where, and when, so those matches are exact rather than a hope that the
 * embedding noticed an id.
 */
export async function recallFacts(options: RecallOptions): Promise<Array<Fact & { distance: number | null }>> {
  // Mid-migration there is nothing to search yet. Saying "I remember nothing"
  // is honest; answering out of a half-filled collection is not.
  if (recallIsPaused()) return [];
  const collection = await getFactsCollection();
  const embedding = await embedQuery(embeddingText(options.query));
  return recallWith(collection, embedding, options);
}

async function recallWith(
  collection: Awaited<ReturnType<typeof getFactsCollection>>,
  embedding: number[],
  options: RecallOptions,
): Promise<Array<Fact & { distance: number | null }>> {
  const base = options.where ?? (options.guildId ? { guildId: options.guildId } : undefined);
  const searches: Array<{ where?: Record<string, unknown>; facet: string | null }> = [{ where: base, facet: null }];

  for (const id of (options.people ?? []).slice(0, MAX_PEOPLE)) {
    searches.push({
      // Who it is about, or failing that whose message it came from.
      where: bothOf(base, { $or: [{ subjectIds: { $contains: id } }, { authorIds: { $contains: id } }] }),
      facet: `person:${id}`,
    });
  }
  for (const id of (options.channels ?? []).slice(0, MAX_PEOPLE)) {
    searches.push({
      where: bothOf(base, { $or: [{ channelRefs: { $contains: id } }, { channelId: id }] }),
      facet: `channel:${id}`,
    });
  }
  const from = readDay(options.dateFrom);
  const to = readDay(options.dateTo) ?? from;
  if (from !== null && to !== null) {
    searches.push({
      where: bothOf(base, {
        $or: [
          // The days the fact itself talks about overlap the ones asked for…
          { $and: [{ dateMin: { $lte: to } }, { dateMax: { $gte: from } }] },
          // …or it was said during them.
          { $and: [{ timePeriodStart: { $lte: (to + 1) * DAY_MS } }, { timePeriodEnd: { $gte: from * DAY_MS } }] },
        ],
      }),
      facet: 'when',
    });
  }

  const found = new Map<string, { fact: Fact & { distance: number | null }; facets: Set<string> }>();
  const results = await Promise.all(searches.map(async (search) => {
    const result = await collection.query({
      queryEmbeddings: [embedding],
      nResults: options.topK,
      where: search.where as never,
      include: ['documents', 'metadatas', 'distances'],
    });
    return { facet: search.facet, rows: result.rows()[0] ?? [] };
  }));

  for (const { facet, rows } of results) {
    for (const row of rows) {
      const existing = found.get(row.id);
      const fact = existing?.fact ?? { ...toFact(row.id, row.document, row.metadata), distance: row.distance ?? null };
      const facets = existing?.facets ?? new Set<string>();
      if (facet) facets.add(facet);
      found.set(row.id, { fact, facets });
    }
  }

  // How near a fact has to be to count at all. Applied to the distance itself
  // rather than to the facet-adjusted score, so the number an operator tunes
  // means one thing: how close the vectors are. Facets reorder what got in;
  // they cannot smuggle in something unrelated. 0 switches the ceiling off.
  const ceiling = options.maxDistance ?? getSettings().factSearchMaxDistance / 100;
  const near = ceiling > 0
    // A null distance is "not reported", not "infinitely far".
    ? [...found.values()].filter((entry) => entry.fact.distance === null || entry.fact.distance <= ceiling)
    : [...found.values()];

  const scored = near
    .map((entry) => ({ ...entry, score: (entry.fact.distance ?? 1) - entry.facets.size * FACET_BONUS }))
    .sort((first, second) => first.score - second.score);

  const chosen = scored.slice(0, options.topK);
  // A fact the question is demonstrably about should not be edged out by a
  // slightly closer sentence that is about nobody in particular.
  const missing = scored
    .filter((entry) => entry.facets.size > 0 && !chosen.includes(entry))
    .slice(0, KEEP_FACET_MATCHES);
  for (const entry of missing) {
    const replaceable = [...chosen].reverse().find((candidate) => candidate.facets.size === 0);
    if (!replaceable) break;
    chosen[chosen.indexOf(replaceable)] = entry;
  }

  return chosen.map((entry) => entry.fact);
}

/** Text alone, for the callers that have nothing else to go on. */
export function searchFacts(
  queryText: string,
  topK: number,
  where?: Record<string, unknown>,
): Promise<Array<Fact & { distance: number | null }>> {
  return recallFacts({ query: queryText, topK, where });
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
  const dates = datesIn(candidate.text);
  const metadata: Metadata = {
    guildId: candidate.guildId,
    channelId: identical && previous ? previous.metadata.channelId : candidate.channelId,
    source: identical && previous ? previous.metadata.source : candidate.source,
    createdAt: identical && previous ? previous.metadata.createdAt : Date.now(),
    timePeriodStart: Math.min(candidate.timePeriodStart, previous?.metadata.timePeriodStart ?? candidate.timePeriodStart),
    timePeriodEnd: Math.max(candidate.timePeriodEnd, previous?.metadata.timePeriodEnd ?? candidate.timePeriodEnd),
  };
  for (const key of ['messageIds', 'authorIds', 'referencedFactIds'] as const) {
    const merged = [...new Set([...(previous?.metadata[key] ?? []), ...(candidate[key] ?? [])])];
    // Chroma rejects empty metadata arrays.
    if (merged.length > 0) metadata[key] = merged;
  }

  // Who the fact is *about*, kept apart from whose messages it came from: they
  // are different questions, and mixing them made "facts about Alice" mean
  // "facts Alice happened to be in the room for".
  const subjectIds = [...new Set([...(previous?.metadata.subjectIds ?? []), ...mentionedUserIds(candidate.text)])];
  if (subjectIds.length > 0) metadata.subjectIds = subjectIds;
  const channelRefs = [...new Set([...(previous?.metadata.channelRefs ?? []), ...channelIdsIn(candidate.text)])];
  if (channelRefs.length > 0) metadata.channelRefs = channelRefs;
  // The days the fact talks about, as opposed to when it was said.
  if (dates.length > 0) {
    metadata.dateMin = Math.min(...dates);
    metadata.dateMax = Math.max(...dates);
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
  // Ids and dates are stripped before embedding, and matched exactly through
  // metadata instead; the stored text keeps them.
  const embeddings = await embedDocuments(pending.map((candidate) => embeddingText(candidate.text)));

  return mutateFacts(async () => {
    const threshold = getSettings().duplicateDistance / 100;
    const collection = await getFactsCollection();
    const savedIds = new Set<string>();

    for (const [index, candidate] of pending.entries()) {
      // Source overlap alone proves nothing: one message can contain several
      // independent facts. Each completed write is visible to the next candidate.
      // The candidate's own vector is already in hand, so this costs no second
      // embedding of the same sentence.
      const [nearest] = await recallWith(collection, embeddings[index], {
        // No recall ceiling here: this comparison has its own threshold, and a
        // tighter search ceiling would hide a real duplicate and store it twice.
        query: candidate.text, topK: 1, guildId: candidate.guildId, maxDistance: 0,
      });
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
    // A job copies the store as it was when it started, so anything written
    // since has to join its snapshot or the swap would leave it behind.
    noteFactsChanged(collectionNameFor(activeEmbedding()), [...savedIds]);
    return [...savedIds];
  });
}

export async function deleteFact(id: string): Promise<boolean> {
  return mutateFacts(async () => {
    const collection = await getFactsCollection();
    const existing = await collection.get({ ids: [id] });
    if (existing.ids.length === 0) return false;
    await collection.delete({ ids: [id] });
    // Otherwise an open job would copy it back out of the source it was deleted
    // from, and a forgotten fact would return at the swap.
    dropFromSnapshot(id);
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
  // Somebody a fact is about counts as much as somebody whose message it came
  // from: "facts about Alice" should not mean "facts Alice was in the room for".
  const filtered = options.authorId
    ? all.filter((fact) => peopleIn(fact).includes(options.authorId!))
    : all;
  const sorted = filtered.sort((a, b) => b.metadata.createdAt - a.metadata.createdAt);
  const start = (options.page - 1) * options.pageSize;
  return { facts: sorted.slice(start, start + options.pageSize), total: sorted.length };
}
