import { randomUUID } from 'node:crypto';
import type { Metadata } from 'chromadb';
import { collectionNameFor, getFactsCollection } from '../chroma';
import { activeEmbedding } from '../../ai/embeddings';
import { dropFromSnapshot, noteFactsChanged, recallIsPaused } from './reembedRepo';
import { embedDocuments, embedQuery, embedWith } from '../../ai/embeddings';
import { getSettings } from './settingsRepo';
import { duplicateDistanceFor, searchLimitsFor } from './factTypesRepo';
import { clearFactIndex, indexFacts, indexedCount, pageOfFactIds, unindexFact, untypedFactIds } from './factIndexRepo';
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
      types: meta.types ?? [],
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

/** The array fields, which Chroma stores as lists and refuses to store empty. */
const LIST_FIELDS = ['messageIds', 'authorIds', 'subjectIds', 'channelRefs', 'types', 'referencedFactIds'] as const;

/**
 * A fact's metadata on its way back to Chroma.
 *
 * `toFact` fills every missing array in with `[]` so everything reading a fact
 * can treat them as lists without guarding each one. Writing that back is a
 * different matter: Chroma rejects an empty list outright — *"Expected metadata
 * list value for key 'channelRefs' to be non-empty"* — and for `types` the
 * absence is meaningful anyway, since it is what marks a fact nobody has sorted.
 * So an empty one is dropped rather than written, exactly as `metadataFor` does
 * on the way in.
 */
export function chromaMetadata(metadata: FactMetadata): Metadata {
  const out: Metadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    if ((LIST_FIELDS as readonly string[]).includes(key) && Array.isArray(value) && value.length === 0) continue;
    out[key] = value as Metadata[string];
  }
  return out;
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
/**
 * How many untyped facts a type-filtered search will reach for alongside.
 * Bounded because it is a literal id list on a query; it shrinks to nothing as
 * the cleanup pass sorts the store, which is the point.
 */
const UNTYPED_COMPANION_CAP = 2000;

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
  /** An extra Chroma filter, such as one channel or one type. */
  where?: Record<string, unknown>;
  /** Restricts the search to these records, which is how untyped facts are reached. */
  ids?: string[];
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
      // Restricting to a set of records is how a type-filtered search still
      // reaches the facts nobody has typed: Chroma cannot match a missing key.
      ...(options.ids ? { ids: options.ids } : {}),
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

/** A fact, plus which of the searches turned it up. */
export type RecalledFact = Fact & { distance: number | null; foundBy: string[] };

export interface FactSearchRequest {
  query: string;
  /** One of the operator's fact types, or empty to search everything. */
  type?: string;
  people?: string[];
  channels?: string[];
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Several searches at once, merged.
 *
 * A question about two people and a rule is three different searches, and
 * flattening it into one embedding was the reason recall kept returning the
 * nearest thing to an average of them. Every query is embedded in **one**
 * request, so N searches cost N embeddings and no extra chat calls.
 *
 * A search naming a type is filtered to it. That is the one facet that filters
 * rather than lifts, and it has to be: once `message` outnumbers everything
 * else, an unfiltered search for a rule comes back as eight things somebody
 * said. Facts nobody has typed yet are included in every typed search — they
 * are the whole store as it stood before types existed, and a filter that hid
 * them would lose the lot until the cleanup pass runs.
 */
export async function recallForSearches(
  searches: FactSearchRequest[],
  guildId?: string,
): Promise<RecalledFact[]> {
  if (recallIsPaused()) return [];
  const wanted = searches.filter((search) => search.query.trim());
  if (wanted.length === 0) return [];

  const collection = await getFactsCollection();
  // One request for every query: the batch is what keeps fanning out cheap.
  const embeddings = await embedWith(wanted.map((search) => embeddingText(search.query)), activeEmbedding());
  // Only worth asking while any remain; once the cleanup pass has sorted the
  // store this is empty and the extra query disappears on its own.
  const untyped = untypedFactIds(UNTYPED_COMPANION_CAP);

  const found = new Map<string, RecalledFact>();
  const results = await Promise.all(wanted.map(async (search, index) => {
    const limits = searchLimitsFor(search.type || undefined);
    const base: RecallOptions = {
      query: search.query,
      topK: limits.topK,
      guildId,
      people: search.people,
      channels: search.channels,
      dateFrom: search.dateFrom,
      dateTo: search.dateTo,
      maxDistance: limits.maxDistance,
    };
    if (!search.type) return { search, rows: await recallWith(collection, embeddings[index], base) };

    // Chroma cannot match a where-clause against a key that is not there, so
    // the untyped ones are asked for by id alongside rather than folded in.
    const [typed, unsorted] = await Promise.all([
      recallWith(collection, embeddings[index], {
        ...base,
        where: bothOf(guildId ? { guildId } : undefined, { types: { $contains: search.type } }),
      }),
      untyped.length === 0 ? Promise.resolve([]) : recallWith(collection, embeddings[index], { ...base, ids: untyped }),
    ]);
    return { search, rows: [...typed, ...unsorted] };
  }));

  for (const { search, rows } of results) {
    for (const row of rows) {
      const existing = found.get(row.id);
      const label = search.type ? `${search.type}: ${search.query}` : search.query;
      if (!existing) {
        found.set(row.id, { ...row, foundBy: [label] });
        continue;
      }
      // Several searches can turn up the same fact. Keep the best distance and
      // remember every search that wanted it, so the model can tell a rule hit
      // from something somebody said.
      if (!existing.foundBy.includes(label)) existing.foundBy.push(label);
      if (row.distance !== null && (existing.distance === null || row.distance < existing.distance)) {
        existing.distance = row.distance;
      }
    }
  }

  return [...found.values()].sort((first, second) => (first.distance ?? 1) - (second.distance ?? 1));
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
  // A merge widens the types rather than replacing them: the older record was
  // sorted against the same list and its reading is not worth less than this
  // one's. Left off entirely when there are none, because Chroma rejects an
  // empty array — and that absence is what marks a fact nobody has typed.
  const types = [...new Set([...(previous?.metadata.types ?? []), ...(candidate.types ?? [])])];
  if (types.length > 0) metadata.types = types;
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

export async function addFacts(candidates: FactCandidate[]): Promise<string[]> {
  const pending = candidates.filter((candidate) => candidate.text.trim()).map((candidate) => ({ ...candidate }));
  if (pending.length === 0) return [];
  // Finish embedding before touching existing records. In particular, an outage
  // must never remove the old wording of a fact being replaced.
  // Ids and dates are stripped before embedding, and matched exactly through
  // metadata instead; the stored text keeps them.
  const embeddings = await embedDocuments(pending.map((candidate) => embeddingText(candidate.text)));

  return mutateFacts(async () => {
    const collection = await getFactsCollection();
    const savedIds = new Set<string>();
    const saved: Fact[] = [];

    for (const [index, candidate] of pending.entries()) {
      // How close counts as the same fact is the candidate's own types' business:
      // a rule restated is a duplicate, two people saying much the same thing on
      // different days is not. The tightest of its types wins, and 0 means never.
      const threshold = duplicateDistanceFor(candidate.types) / 100;
      // At 0 the nearest-neighbour search is skipped outright rather than run and
      // then failed. That query is per candidate, which is the difference between
      // cheap and expensive once `message` is keeping most of the channel.
      const [nearest] = threshold > 0
        // Source overlap alone proves nothing: one message can contain several
        // independent facts. Each completed write is visible to the next candidate.
        // The candidate's own vector is already in hand, so this costs no second
        // embedding of the same sentence.
        ? await recallWith(collection, embeddings[index], {
          // No recall ceiling here: this comparison has its own threshold, and a
          // tighter search ceiling would hide a real duplicate and store it twice.
          query: candidate.text, topK: 1, guildId: candidate.guildId, maxDistance: 0,
        })
        : [];
      const identical = nearest && normalise(nearest.text) === normalise(candidate.text);
      // Similar sentences about different people are independent facts, not
      // updates to each other. Source authors are not a substitute for subjects.
      if (nearest && (identical || (nearest.distance !== null && nearest.distance < threshold
        && sameSubjects(nearest.text, candidate.text)))) {
        const metadata = metadataFor(candidate, nearest, identical);
        await collection.update({
          ids: [nearest.id],
          metadatas: [metadata],
          ...(!identical ? { documents: [candidate.text], embeddings: [embeddings[index]] } : {}),
        });
        // Even an identical candidate can widen the types or the sources, so the
        // index is refreshed either way; only a rewording counts as a save.
        saved.push(toFact(nearest.id, identical ? nearest.text : candidate.text, metadata));
        if (!identical) {
          // Updating one record keeps its ID and references intact. There is no
          // delete-before-add gap, even if the request fails or the process exits.
          savedIds.add(nearest.id);
          console.log(`[facts] updated ${nearest.id}: ${nearest.text.slice(0, 60)}`);
        }
        continue;
      }

      const id = randomUUID();
      const metadata = metadataFor(candidate);
      await collection.add({
        ids: [id], documents: [candidate.text], embeddings: [embeddings[index]], metadatas: [metadata],
      });
      saved.push(toFact(id, candidate.text, metadata));
      savedIds.add(id);
    }
    // Chroma cannot order or offset a `get`, so what was just written is
    // mirrored into SQLite for the screens that page and count.
    indexFacts(saved);
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
    unindexFact(id);
    // Otherwise an open job would copy it back out of the source it was deleted
    // from, and a forgotten fact would return at the swap.
    dropFromSnapshot(id);
    return true;
  });
}

/** The facts behind a set of ids, in the order the ids were given. */
export async function factsByIds(ids: string[]): Promise<Fact[]> {
  if (ids.length === 0) return [];
  const collection = await getFactsCollection();
  const result = await collection.get({ ids, include: ['documents', 'metadatas'] });
  const byId = new Map(result.rows().map((row) => [row.id, toFact(row.id, row.document, row.metadata)]));
  return ids.map((id) => byId.get(id)).filter((fact): fact is Fact => fact !== undefined);
}

/**
 * Facts newest first, optionally narrowed to one person.
 *
 * The ordering and the count come from the SQLite mirror, because Chroma's `get`
 * offers neither; only the page itself is fetched from the store. This used to
 * pull the whole collection over HTTP and sort it in memory, which was a fair
 * trade at a few thousand facts and stopped being one the moment `message`
 * started keeping most of the channel.
 */
export async function listFactsPage(options: {
  page: number;
  pageSize: number;
  authorId?: string;
}): Promise<{ facts: Fact[]; total: number }> {
  await ensureFactIndex();
  const { ids, total } = pageOfFactIds(options);
  return { facts: await factsByIds(ids), total };
}

/**
 * Brings the mirror back in step when it has drifted.
 *
 * Nothing here is the truth, so the cheapest correct answer to "are these the
 * same?" is to count both and rebuild if they differ. It is local and free — no
 * embeddings, no model — so unlike the re-embed it does not wait for somebody to
 * press a button. Facts written before the mirror existed are what it is for.
 */
let indexCheck: Promise<void> | null = null;

export function ensureFactIndex(): Promise<void> {
  indexCheck ??= rebuildIfStale().finally(() => { indexCheck = null; });
  return indexCheck;
}

async function rebuildIfStale(): Promise<void> {
  try {
    const collection = await getFactsCollection();
    const [stored, indexed] = [await collection.count(), indexedCount()];
    if (stored === indexed) return;
    console.log(`[facts] the fact index has ${indexed} of ${stored} facts — rebuilding it`);
    clearFactIndex();
    const PAGE = 500;
    for (let offset = 0; ; offset += PAGE) {
      const page = await collection.get({ limit: PAGE, offset, include: ['documents', 'metadatas'] });
      const rows = page.rows();
      if (rows.length > 0) indexFacts(rows.map((row) => toFact(row.id, row.document, row.metadata)));
      // A short page is the last one. Stopping on that rather than on an empty
      // one also ends the loop if the store ever ignores the offset, instead of
      // re-reading the same page until the process is killed.
      if (rows.length < PAGE) break;
    }
    console.log(`[facts] the fact index is rebuilt with ${indexedCount()} facts`);
  } catch (error) {
    // A browse that pages a little wrongly is better than a screen that will not
    // open, and the next call tries again.
    console.warn(`[facts] could not rebuild the fact index: ${error instanceof Error ? error.message : String(error)}`);
  }
}
