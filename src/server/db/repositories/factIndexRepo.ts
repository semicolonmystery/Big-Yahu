import { desc, eq, inArray, like, sql, type SQL } from 'drizzle-orm';
import { db } from '../client';
import { factIndex } from '../schema';
import type { Fact } from '@shared/types';

/**
 * A SQLite mirror of what is in the fact store, for the questions Chroma cannot
 * answer: newest first, page three, how many are there, and which facts nobody
 * has typed yet.
 *
 * Chroma's `get` offers neither ordering nor an offset, so browsing used to pull
 * every fact over HTTP and sort it in memory. Near-total message retention makes
 * that untenable. This is a cache and never the truth — Chroma is — so it is
 * rebuilt whenever the two disagree on how many facts exist.
 */

/** A space at each end, so `LIKE '% id %'` matches a whole id and not the middle of a longer one. */
const packed = (values: readonly string[]): string =>
  values.length > 0 ? ` ${[...new Set(values)].join(' ')} ` : ' ';

const containsId = (column: typeof factIndex.types | typeof factIndex.people, id: string): SQL =>
  like(column, `% ${id} %`);

export interface IndexedFact {
  factId: string;
  guildId: string;
  createdAt: number;
  types: string[];
  people: string[];
  messages: string[];
}

function rowFor(fact: Fact) {
  return {
    factId: fact.id,
    guildId: fact.metadata.guildId ?? '',
    createdAt: fact.metadata.createdAt ?? 0,
    types: packed(fact.metadata.types ?? []),
    people: packed([...(fact.metadata.authorIds ?? []), ...(fact.metadata.subjectIds ?? [])]),
    messages: packed(fact.metadata.messageIds ?? []),
  };
}

export function indexFacts(facts: Fact[]): void {
  if (facts.length === 0) return;
  const rows = facts.map(rowFor);
  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(factIndex).values(row).onConflictDoUpdate({
        target: factIndex.factId,
        set: {
          guildId: row.guildId, createdAt: row.createdAt,
          types: row.types, people: row.people, messages: row.messages,
        },
      }).run();
    }
  });
}

export function unindexFact(id: string): void {
  db.delete(factIndex).where(eq(factIndex.factId, id)).run();
}

export function indexedCount(): number {
  return db.select({ count: sql<number>`count(*)` }).from(factIndex).get()?.count ?? 0;
}

export function clearFactIndex(): void {
  db.delete(factIndex).run();
}

/** Ids of facts nobody has typed yet — every type search has to include them. */
export function untypedFactIds(limit?: number): string[] {
  const query = db.select({ factId: factIndex.factId }).from(factIndex).where(eq(factIndex.types, ' '));
  const rows = limit === undefined ? query.all() : query.limit(limit).all();
  return rows.map((row) => row.factId);
}

export function untypedFactCount(): number {
  return db.select({ count: sql<number>`count(*)` }).from(factIndex).where(eq(factIndex.types, ' ')).get()?.count ?? 0;
}

/** Fact ids carrying any of these types, newest first. Empty `types` means every fact. */
export function factIdsOfTypes(types: string[]): string[] {
  if (types.length === 0) {
    return db.select({ factId: factIndex.factId }).from(factIndex).orderBy(desc(factIndex.createdAt)).all()
      .map((row) => row.factId);
  }
  const rows = db.select({ factId: factIndex.factId, types: factIndex.types }).from(factIndex)
    .orderBy(desc(factIndex.createdAt)).all();
  const wanted = new Set(types);
  return rows
    .filter((row) => row.types.trim().split(/\s+/).filter(Boolean).some((id) => wanted.has(id)))
    .map((row) => row.factId);
}

/**
 * One page of fact ids, newest first, optionally narrowed to one person.
 *
 * Somebody a fact is about counts as much as somebody whose message it came
 * from, which is why both go into `people`.
 */
export function pageOfFactIds(options: { page: number; pageSize: number; authorId?: string }): {
  ids: string[];
  total: number;
} {
  const where = options.authorId ? containsId(factIndex.people, options.authorId) : undefined;
  const total = db.select({ count: sql<number>`count(*)` }).from(factIndex)
    .where(where).get()?.count ?? 0;
  const ids = db.select({ factId: factIndex.factId }).from(factIndex)
    .where(where)
    .orderBy(desc(factIndex.createdAt), desc(factIndex.factId))
    .limit(options.pageSize)
    .offset(Math.max(0, (options.page - 1) * options.pageSize))
    .all()
    .map((row) => row.factId);
  return { ids, total };
}

/** Every source message any fact cites, for the dashboard's counter. */
export function indexedMessageIds(): string[] {
  const rows = db.select({ messages: factIndex.messages }).from(factIndex).all();
  const ids = new Set<string>();
  for (const row of rows) for (const id of row.messages.trim().split(/\s+/)) if (id) ids.add(id);
  return [...ids];
}

/** How many facts each person is in, counting who a fact is about as much as who said it. */
export function factCountsByPerson(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of db.select({ people: factIndex.people }).from(factIndex).all()) {
    for (const id of new Set(row.people.trim().split(/\s+/))) {
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Everyone any fact is about or came from, for the people filter on the facts screen. */
export function indexedPeople(): string[] {
  const rows = db.select({ people: factIndex.people }).from(factIndex).all();
  const ids = new Set<string>();
  for (const row of rows) for (const id of row.people.trim().split(/\s+/)) if (id) ids.add(id);
  return [...ids];
}

export function indexedFacts(ids: string[]): IndexedFact[] {
  if (ids.length === 0) return [];
  return db.select().from(factIndex).where(inArray(factIndex.factId, ids)).all().map((row) => ({
    factId: row.factId,
    guildId: row.guildId,
    createdAt: row.createdAt,
    types: row.types.trim().split(/\s+/).filter(Boolean),
    people: row.people.trim().split(/\s+/).filter(Boolean),
    messages: row.messages.trim().split(/\s+/).filter(Boolean),
  }));
}
