import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactCandidate } from '../../src/server/db/repositories/factsRepo';

const state = vi.hoisted(() => {
  const rows = new Map<string, { id: string; document: string; vector: number; metadata: Record<string, any> }>();
  /** A vector is just the index of the text it was made from, so a stub can tell two apart. */
  const vectors = new Map<string, number>();
  const index = (text: string): number => {
    if (!vectors.has(text)) vectors.set(text, vectors.size);
    return vectors.get(text)!;
  };
  const distance = { different: 1 };
  /** Per-document distances, for the cases where the order of the near misses is the point. */
  const distances = new Map<string, number>();

  /** Enough of Chroma's filter language for what recall builds. */
  const matches = (metadata: Record<string, any>, where?: Record<string, any>): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, value]) => {
      if (key === '$and') return (value as any[]).every((clause) => matches(metadata, clause));
      if (key === '$or') return (value as any[]).some((clause) => matches(metadata, clause));
      const actual = metadata[key];
      if (value && typeof value === 'object') {
        return Object.entries(value as Record<string, any>).every(([operator, operand]) => {
          if (operator === '$contains') return Array.isArray(actual) && actual.includes(operand);
          if (operator === '$lte') return typeof actual === 'number' && actual <= operand;
          if (operator === '$gte') return typeof actual === 'number' && actual >= operand;
          throw new Error(`the stub does not implement ${operator}`);
        });
      }
      return actual === value;
    });
  };

  const collection = {
    get: vi.fn(async ({ ids, limit, offset = 0 }: { ids?: string[]; limit?: number; offset?: number } = {}) => {
      const matching = [...rows.values()].filter((row) => !ids || ids.includes(row.id));
      // Chroma pages a `get`, and the index rebuild walks it — a stub that
      // ignored these would loop over the first page forever.
      const found = limit === undefined ? matching : matching.slice(offset, offset + limit);
      return { ids: found.map((row) => row.id), rows: () => found };
    }),
    query: vi.fn(async (
      { queryEmbeddings, nResults = 1, where }:
      { queryEmbeddings: number[][]; nResults?: number; where?: Record<string, any> },
    ) => {
      const asked = queryEmbeddings[0][0];
      const found = [...rows.values()]
        .filter((row) => matches(row.metadata, where))
        .map((row) => ({
          ...row,
          distance: row.vector === asked ? 0 : distances.get(row.document) ?? distance.different,
        }))
        .sort((first, second) => first.distance - second.distance)
        .slice(0, nResults);
      return { rows: () => [found] };
    }),
    add: vi.fn(async (args: { ids: string[]; documents: string[]; embeddings: number[][]; metadatas: Record<string, any>[] }) => {
      for (const [position, id] of args.ids.entries()) {
        rows.set(id, {
          id, document: args.documents[position], vector: args.embeddings[position][0], metadata: args.metadatas[position],
        });
      }
    }),
    update: vi.fn(async (args: { ids: string[]; documents?: string[]; embeddings?: number[][]; metadatas: Record<string, any>[] }) => {
      for (const [position, id] of args.ids.entries()) {
        const old = rows.get(id)!;
        rows.set(id, {
          id,
          document: args.documents?.[position] ?? old.document,
          vector: args.embeddings?.[position][0] ?? old.vector,
          metadata: args.metadatas[position],
        });
      }
    }),
    delete: vi.fn(async ({ ids }: { ids: string[] }) => { for (const id of ids) rows.delete(id); }),
    count: vi.fn(async () => rows.size),
  };
  return {
    rows, distance, distances, collection, index,
    settings: { duplicateDistance: 25, factSearchMaxDistance: 0 },
    recallPaused: false,
    noteFactsChanged: vi.fn(),
    dropFromSnapshot: vi.fn(),
    embedDocuments: vi.fn(async (texts: string[]) => texts.map((text) => [index(text)])),
  };
});

vi.mock('../../src/server/db/chroma', () => ({
  getFactsCollection: async () => state.collection,
  collectionNameFor: (config: { model: string; dimensions: number }) => `facts__${config.model}__${config.dimensions}`,
}));
vi.mock('../../src/server/db/repositories/reembedRepo', () => ({
  recallIsPaused: () => state.recallPaused,
  noteFactsChanged: state.noteFactsChanged,
  dropFromSnapshot: state.dropFromSnapshot,
}));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({ getSettings: () => state.settings }));
vi.mock('../../src/server/ai/embeddings', () => ({
  activeEmbedding: () => ({ model: 'test/embeddings', dimensions: 3 }),
  embedDocuments: state.embedDocuments,
  // Several searches share one request, which is the whole reason fanning out
  // is cheap, so the stub has to be the same batching call.
  embedWith: state.embedDocuments,
  embedQuery: async (text: string) => [state.index(text)],
}));

import {
  addFacts, deleteFact, embeddingText, listFactsPage, recallFacts, recallForSearches,
} from '../../src/server/db/repositories/factsRepo';
import { withAIRequestBudget } from '../../src/server/ai/requestBudget';
import { db } from '../../src/server/db/client';
import { factIndex, factTypes } from '../../src/server/db/schema';
import { addFactType, listFactTypes, updateFactType } from '../../src/server/db/repositories/factTypesRepo';

const candidate = (text: string, overrides: Partial<FactCandidate> = {}): FactCandidate => ({
  text, messageIds: ['message-1'], authorIds: ['author-1'], guildId: 'guild', channelId: 'channel',
  referencedFactIds: ['reference-1'], source: 'auto', timePeriodStart: 100, timePeriodEnd: 200, ...overrides,
});

/** Whole days since the epoch, the unit the date metadata is in. */
const day = (value: string) => {
  const [d, m, y] = value.split('.').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
};

beforeEach(() => {
  vi.clearAllMocks();
  state.rows.clear();
  state.distances.clear();
  state.distance.different = 1;
  state.settings.duplicateDistance = 25;
  state.settings.factSearchMaxDistance = 0;
  state.recallPaused = false;
  // The SQLite mirror is real here; the Chroma stub is what is emptied above, so
  // the two have to be cleared together or the index describes facts that are gone.
  db.delete(factIndex).run();
  db.delete(factTypes).run();
});

describe('fact persistence', () => {
  it('keeps independent facts citing the same source message', async () => {
    await addFacts([candidate('Alice owns a dog')]);
    await addFacts([candidate('Alice teaches physics')]);
    expect([...state.rows.values()].map((row) => row.document)).toEqual(['Alice owns a dog', 'Alice teaches physics']);
  });

  it('deduplicates candidates within one batch', async () => {
    const saved = await addFacts([candidate('Alice owns a dog'), candidate('Alice owns a dog')]);
    expect(saved).toHaveLength(1);
    expect(state.rows.size).toBe(1);
  });

  it('does not replace a semantically similar fact about somebody else', async () => {
    await addFacts([candidate('<@111> owns a dog')]);
    state.distance.different = 0.1;
    await addFacts([candidate('<@222> owns a dog', { messageIds: ['message-2'] })]);
    expect([...state.rows.values()].map((row) => row.document)).toEqual(['<@111> owns a dog', '<@222> owns a dog']);
  });

  it('still updates semantically matching facts about the same subjects', async () => {
    const [id] = await addFacts([candidate('<@111> and <@222> meet on Monday')]);
    state.distance.different = 0.1;
    await addFacts([candidate('<@222> and <@111> moved their meeting to Tuesday', { messageIds: ['message-2'] })]);
    expect(state.rows.size).toBe(1);
    expect(state.rows.get(id)?.document).toBe('<@222> and <@111> moved their meeting to Tuesday');
  });

  it('serializes concurrent saves and preserves every source, author, reference and time range', async () => {
    await Promise.all([
      addFacts([candidate('Alice owns a dog')]),
      addFacts([candidate('Alice owns a dog', {
        messageIds: ['message-2'], authorIds: ['author-2'], referencedFactIds: ['reference-2'],
        timePeriodStart: 50, timePeriodEnd: 300,
      })]),
    ]);
    expect(state.rows.size).toBe(1);
    expect([...state.rows.values()][0].metadata).toMatchObject({
      messageIds: ['message-1', 'message-2'], authorIds: ['author-1', 'author-2'],
      referencedFactIds: ['reference-1', 'reference-2'], timePeriodStart: 50, timePeriodEnd: 300,
    });
  });

  it('replaces semantically matching wording using the same ID, one update, and no second embedding', async () => {
    const [id] = await addFacts([candidate('The meeting is on Monday')]);
    state.distance.different = 0.1;
    state.embedDocuments.mockClear();
    const saved = await addFacts([candidate('The meeting moved to Tuesday', { messageIds: ['message-2'] })]);
    expect(saved).toEqual([id]);
    expect(state.rows.get(id)?.document).toBe('The meeting moved to Tuesday');
    expect(state.rows.get(id)?.metadata.messageIds).toEqual(['message-1', 'message-2']);
    expect(state.collection.delete).not.toHaveBeenCalled();
    // The vector written is the one already computed for the new wording: the
    // dedupe comparison reuses it rather than embedding the sentence twice.
    expect(state.embedDocuments).toHaveBeenCalledTimes(1);
    expect(state.collection.update).toHaveBeenCalledWith(expect.objectContaining({
      ids: [id], documents: ['The meeting moved to Tuesday'], embeddings: [[state.index('The meeting moved to Tuesday')]],
    }));
  });

  it('preserves the original when replacement embedding fails', async () => {
    const [id] = await addFacts([candidate('Original')]);
    state.embedDocuments.mockRejectedValueOnce(new Error('OpenRouter unavailable'));
    await expect(addFacts([candidate('Replacement')])).rejects.toThrow('OpenRouter unavailable');
    expect(state.rows.get(id)?.document).toBe('Original');
    expect(state.collection.delete).not.toHaveBeenCalled();
  });

  it('preserves the original on an update failure and allows later mutations', async () => {
    const [id] = await addFacts([candidate('Original')]);
    state.distance.different = 0.1;
    state.collection.update.mockRejectedValueOnce(new Error('Chroma unavailable'));
    await expect(addFacts([candidate('Replacement')])).rejects.toThrow('Chroma unavailable');
    expect(state.rows.get(id)?.document).toBe('Original');
    expect(await deleteFact(id)).toBe(true);
    expect(state.rows.size).toBe(0);
  });

  it('releases an expired reply waiting for the mutation queue and never runs its deletion later', async () => {
    const [id] = await addFacts([candidate('Original')]);
    let unblock!: () => void;
    let started!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    state.collection.query.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => { unblock = resolve; });
      return { rows: () => [[]] };
    });
    const first = addFacts([candidate('Background extraction')]);
    await reached;
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const queued = withAIRequestBudget(() => deleteFact(id));
    const assertion = expect(queued).rejects.toThrow('Reply expired');
    controller.abort(new Error('Reply expired'));
    await assertion;
    expect(state.collection.delete).not.toHaveBeenCalled();
    unblock();
    await first;
    // A later operation drains the cancelled slot before it can finish.
    await addFacts([candidate('Subsequent write')]);
    expect(state.rows.get(id)?.document).toBe('Original');
    expect(state.collection.delete).not.toHaveBeenCalled();
  });
});

describe('the duplicate distance setting', () => {
  // The operator calibrates this by hand, so the number has to reach the
  // comparison rather than sit in Settings looking like it does.
  const pair = async () => {
    await addFacts([candidate('<@111> is going on Monday')]);
    state.distance.different = 0.3;
    await addFacts([candidate('<@111> is going on Tuesday', { messageIds: ['message-2'] })]);
    return state.rows.size;
  };

  it('keeps a pair apart when they are further off than the setting allows', async () => {
    state.settings.duplicateDistance = 25;
    expect(await pair()).toBe(2);
  });

  it('merges that same pair once the setting is widened past their distance', async () => {
    state.settings.duplicateDistance = 35;
    expect(await pair()).toBe(1);
    expect([...state.rows.values()][0].document).toBe('<@111> is going on Tuesday');
  });
});

describe('while a re-embed is running', () => {
  it('says it remembers nothing rather than answering out of a half-filled collection', async () => {
    await addFacts([candidate('Alice owns a dog')]);
    state.distance.different = 0.1;
    state.recallPaused = true;
    // Only what recall does from here matters; the write above searched too.
    state.collection.query.mockClear();
    expect(await recallFacts({ query: 'pets', topK: 5, guildId: 'guild' })).toEqual([]);
    expect(state.collection.query).not.toHaveBeenCalled();
  });

  it('adds a newly written fact to the job, so the swap cannot leave it behind', async () => {
    const [id] = await addFacts([candidate('Written during the move')]);
    expect(state.noteFactsChanged).toHaveBeenCalledWith('facts__test/embeddings__3', [id]);
  });

  it('takes a deleted fact out of the job, so it cannot come back at the swap', async () => {
    const [id] = await addFacts([candidate('Deleted during the move')]);
    expect(await deleteFact(id)).toBe(true);
    expect(state.dropFromSnapshot).toHaveBeenCalledWith(id);
  });

  it('does not take a fact out of the job when nothing was deleted', async () => {
    expect(await deleteFact('never-existed')).toBe(false);
    expect(state.dropFromSnapshot).not.toHaveBeenCalled();
  });
});

describe('what is embedded', () => {
  it('drops the ids and dates that an embedding cannot mean anything by', () => {
    expect(embeddingText('<@111> is meeting <@222> in <#333> on 03.04.2026'))
      .toBe('someone is meeting someone in a channel on');
  });

  it('leaves ordinary wording, including quoted words, alone', () => {
    expect(embeddingText('Alice calls the build "the swamp"')).toBe('Alice calls the build "the swamp"');
  });

  it('sends the stripped text to the model while storing the original', async () => {
    await addFacts([candidate('<@222> owns a dog')]);
    expect(state.embedDocuments).toHaveBeenCalledWith(['someone owns a dog']);
    expect([...state.rows.values()][0].document).toBe('<@222> owns a dog');
  });
});

describe('fact metadata', () => {
  it('separates who a fact is about from whose message it came from', async () => {
    const [id] = await addFacts([candidate('<@222> owns a dog', { authorIds: ['111'] })]);
    const { metadata } = state.rows.get(id)!;
    expect(metadata.authorIds).toEqual(['111']);
    expect(metadata.subjectIds).toEqual(['222']);
    // Either way of being in a fact still finds it in the panel.
    for (const person of ['111', '222']) {
      expect((await listFactsPage({ page: 1, pageSize: 10, authorId: person })).facts.map((fact) => fact.id)).toEqual([id]);
    }
  });

  it('records the channels and the span of days a fact talks about', async () => {
    const [id] = await addFacts([candidate('The move to <#555> happens between 03.04.2026 and 05.04.2026')]);
    expect(state.rows.get(id)!.metadata).toMatchObject({
      channelRefs: ['555'], dateMin: day('3.4.2026'), dateMax: day('5.4.2026'),
    });
  });

  it('leaves the date bounds off a fact that names no date', async () => {
    const [id] = await addFacts([candidate('Alice owns a dog')]);
    expect(state.rows.get(id)!.metadata).not.toHaveProperty('dateMin');
  });
});

describe('recall', () => {
  const about = (text: string, overrides: Partial<FactCandidate> = {}) => candidate(text, overrides);

  it('lifts a fact the question is demonstrably about', async () => {
    await addFacts([about('<@222> owns a dog')]);
    await addFacts([about('Somebody owns a cat')]);
    state.distances.set('<@222> owns a dog', 0.42);
    state.distances.set('Somebody owns a cat', 0.4);

    const withoutPerson = await recallFacts({ query: 'pets', topK: 2, guildId: 'guild' });
    expect(withoutPerson.map((fact) => fact.text)).toEqual(['Somebody owns a cat', '<@222> owns a dog']);

    const withPerson = await recallFacts({ query: 'pets', topK: 2, guildId: 'guild', people: ['222'] });
    expect(withPerson.map((fact) => fact.text)).toEqual(['<@222> owns a dog', 'Somebody owns a cat']);
  });

  it('never hides a fact that matches no facet', async () => {
    await addFacts([about('<@222> owns a dog')]);
    await addFacts([about('Somebody owns a cat')]);
    state.distances.set('<@222> owns a dog', 0.9);
    state.distances.set('Somebody owns a cat', 0.1);

    const found = await recallFacts({ query: 'pets', topK: 2, guildId: 'guild', people: ['222'], dateFrom: '3.4.2026' });
    expect(found.map((fact) => fact.text).sort()).toEqual(['<@222> owns a dog', 'Somebody owns a cat']);
  });

  it('finds a fact by the person it is about or the person who said it', async () => {
    await addFacts([about('<@222> owns a dog', { authorIds: ['111'] })]);
    state.distance.different = 0.9;
    for (const person of ['111', '222']) {
      const found = await recallFacts({ query: 'anything', topK: 1, guildId: 'guild', people: [person] });
      expect(found[0].distance).toBe(0.9);
      expect(found.map((fact) => fact.text)).toEqual(['<@222> owns a dog']);
    }
  });

  it('matches a fact by the days it talks about, and by when it was said', async () => {
    await addFacts([about('The release is on 04.04.2026', { timePeriodStart: 0, timePeriodEnd: 1 })]);
    await addFacts([about('Something was said that week', {
      timePeriodStart: day('3.4.2026') * 86_400_000, timePeriodEnd: day('4.4.2026') * 86_400_000,
    })]);
    state.distance.different = 0.5;

    const spoken = await recallFacts({ query: 'anything', topK: 2, guildId: 'guild', dateFrom: '3.4.2026', dateTo: '5.4.2026' });
    expect(spoken).toHaveLength(2);

    // A fact about days outside the span gets no lift from the date search.
    const narrowed = await recallFacts({ query: 'anything', topK: 2, guildId: 'guild', dateFrom: '1.1.2020', dateTo: '2.1.2020' });
    expect(narrowed.every((fact) => fact.distance === 0.5)).toBe(true);
  });

  it('drops anything past the configured distance ceiling, and returns nothing when all of it is', async () => {
    await addFacts([about('<@222> owns a dog')]);
    await addFacts([about('Somebody owns a cat')]);
    state.distances.set('<@222> owns a dog', 0.3);
    state.distances.set('Somebody owns a cat', 0.8);

    state.settings.factSearchMaxDistance = 50;
    const near = await recallFacts({ query: 'pets', topK: 5, guildId: 'guild' });
    expect(near.map((fact) => fact.text)).toEqual(['<@222> owns a dog']);

    // A question with nothing behind it comes back empty rather than with the
    // least-bad match, which is the whole point of the ceiling.
    state.settings.factSearchMaxDistance = 10;
    expect(await recallFacts({ query: 'pets', topK: 5, guildId: 'guild' })).toEqual([]);

    state.settings.factSearchMaxDistance = 0;
    expect(await recallFacts({ query: 'pets', topK: 5, guildId: 'guild' })).toHaveLength(2);
  });

  it('will not let a facet match smuggle in something past the ceiling', async () => {
    await addFacts([about('<@222> owns a dog')]);
    state.distances.set('<@222> owns a dog', 0.8);
    state.settings.factSearchMaxDistance = 50;
    // Named in the question, but nowhere near it: the bonus reorders what got
    // in, it does not raise the ceiling.
    expect(await recallFacts({ query: 'pets', topK: 5, guildId: 'guild', people: ['222'] })).toEqual([]);
  });

  it('never applies the ceiling to the duplicate comparison', async () => {
    state.settings.factSearchMaxDistance = 5;
    await addFacts([about('<@111> is going on Monday')]);
    state.distance.different = 0.2;
    // 0.2 is past the search ceiling but inside the duplicate threshold, and
    // dedupe has to see it or the same fact gets stored twice.
    await addFacts([about('<@111> is going on Tuesday', { messageIds: ['message-2'] })]);
    expect(state.rows.size).toBe(1);
  });

  it('keeps another server out of the answer', async () => {
    await addFacts([about('Ours')]);
    await addFacts([about('Theirs', { guildId: 'elsewhere' })]);
    state.distance.different = 0.5;
    const found = await recallFacts({ query: 'anything', topK: 5, guildId: 'guild' });
    expect(found.map((fact) => fact.text)).toEqual(['Ours']);
  });
});

describe('types decide what counts as a duplicate', () => {
  const typed = (text: string, types: string[], overrides: Partial<FactCandidate> = {}) =>
    candidate(text, { types, ...overrides });

  it('merges a rule restated, at the distance that type carries', async () => {
    state.distance.different = 0.2;
    await addFacts([typed('<@111> hosts on Fridays', ['rule'])]);
    await addFacts([typed('<@111> hosts on Saturdays', ['rule'], { messageIds: ['m2'] })]);
    expect(state.rows.size).toBe(1);
  });

  // Deliberately the only facts in the store, and about the same person: with
  // anything else in there a tie could hand the comparison to a fact that merely
  // has different subjects, and the test would pass without the types mattering.
  it('keeps two things somebody said apart, because message ships with the check off', async () => {
    state.distance.different = 0.2;
    await addFacts([typed('<@222> said the server is down', ['message'])]);
    await addFacts([typed('<@222> said the server is up', ['message'], { messageIds: ['m3'] })]);
    expect(state.rows.size).toBe(2);
  });

  it('takes the tightest of a fact’s several types, so message keeps them apart', async () => {
    state.distance.different = 0.2;
    await addFacts([typed('<@111> said we play at eight', ['decision', 'message'])]);
    await addFacts([typed('<@111> said we play at nine', ['decision', 'message'], { messageIds: ['m2'] })]);
    // `decision` alone would have merged these at 0.2. `message` is on both and
    // switches the check off, and the most conservative type wins.
    expect(state.rows.size).toBe(2);
  });

  it('skips the neighbour search entirely when the check is off, rather than running and failing it', async () => {
    await addFacts([typed('<@111> said something', ['message'])]);
    state.collection.query.mockClear();
    await addFacts([typed('<@111> said something else', ['message'], { messageIds: ['m2'] })]);
    // The query is per candidate, which is what makes it expensive once `message`
    // is keeping most of the channel.
    expect(state.collection.query).not.toHaveBeenCalled();
  });

  it('falls back to the global setting for a fact nobody has typed', async () => {
    state.distance.different = 0.2;
    await addFacts([candidate('<@111> owns a dog')]);
    await addFacts([candidate('<@111> owns a cat', { messageIds: ['m2'] })]);
    expect(state.rows.size).toBe(1);
  });

  it('widens the types on a merge instead of replacing them', async () => {
    state.distance.different = 0.2;
    const [id] = await addFacts([typed('<@111> hosts on Fridays', ['rule'])]);
    await addFacts([typed('<@111> hosts on Saturdays', ['rule', 'decision'], { messageIds: ['m2'] })]);
    expect(state.rows.get(id)!.metadata.types).toEqual(['rule', 'decision']);
  });

  it('follows a type whose distance the operator has retuned', async () => {
    state.distance.different = 0.2;
    updateFactType('message', { duplicateDistance: 30 });
    await addFacts([typed('<@111> said one thing', ['message'])]);
    await addFacts([typed('<@111> said another', ['message'], { messageIds: ['m2'] })]);
    expect(state.rows.size).toBe(1);
  });

  it('leaves the types off a fact given none, so every type search still finds it', async () => {
    const [id] = await addFacts([candidate('<@111> owns a dog')]);
    // Chroma rejects an empty array, and that absence is what marks it untyped.
    expect(state.rows.get(id)!.metadata.types).toBeUndefined();
  });

  it('ignores a type nobody defined', async () => {
    expect(listFactTypes().map((type) => type.id)).toContain('rule');
    addFactType({ id: 'project', label: 'Project', description: 'An ongoing thing the server is doing.' });
    const [id] = await addFacts([typed('<@111> runs the modpack', ['project', 'invented'])]);
    expect(state.rows.get(id)!.metadata.types).toEqual(['project', 'invented']);
  });
});

describe('browsing without reading the whole store', () => {
  it('pages newest first out of SQLite and fetches only that page', async () => {
    // Stamped rather than slept: `createdAt` is what the mirror orders by, and
    // three writes in the same millisecond would tie.
    const clock = vi.spyOn(Date, 'now');
    for (const [position, text] of ['oldest', 'middle', 'newest'].entries()) {
      clock.mockReturnValue(1_000_000 + position * 1000);
      await addFacts([candidate(text, { messageIds: [`m${position}`] })]);
    }
    clock.mockRestore();
    const first = await listFactsPage({ page: 1, pageSize: 2 });
    expect(first.facts.map((fact) => fact.text)).toEqual(['newest', 'middle']);
    expect(first.total).toBe(3);
    expect((await listFactsPage({ page: 2, pageSize: 2 })).facts.map((fact) => fact.text)).toEqual(['oldest']);
  });

  it('rebuilds the mirror when it does not describe the store', async () => {
    await addFacts([candidate('Alice owns a dog')]);
    // As though the facts predated the mirror entirely.
    db.delete(factIndex).run();
    expect((await listFactsPage({ page: 1, pageSize: 10 })).total).toBe(1);
    // And again, to prove the rebuild does not double-count.
    expect((await listFactsPage({ page: 1, pageSize: 10 })).total).toBe(1);
  });

  it('forgets a deleted fact rather than paging a gap', async () => {
    const [id] = await addFacts([candidate('Alice owns a dog')]);
    await addFacts([candidate('Alice teaches physics', { messageIds: ['m2'] })]);
    await deleteFact(id);
    const page = await listFactsPage({ page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.facts.map((fact) => fact.text)).toEqual(['Alice teaches physics']);
  });
});

describe('several searches at once', () => {
  const typed = (text: string, types: string[], overrides: Partial<FactCandidate> = {}) =>
    candidate(text, { types, ...overrides });

  it('embeds every query in one request rather than one apiece', async () => {
    await addFacts([typed('<@111> hosts on Fridays', ['rule'])]);
    state.embedDocuments.mockClear();
    await recallForSearches([
      { query: 'the hosting rule', type: 'rule' },
      { query: 'what <@111> said', type: 'message' },
      { query: 'anything at all' },
    ], 'guild');
    // Three searches, one embedding request: the batch is what keeps fanning out cheap.
    expect(state.embedDocuments).toHaveBeenCalledTimes(1);
    expect(state.embedDocuments.mock.calls[0][0]).toHaveLength(3);
  });

  it('filters a typed search to that type, which an unfiltered one would bury', async () => {
    state.distance.different = 0.5;
    await addFacts([typed('<@111> hosts on Fridays', ['rule'])]);
    for (const [index, text] of ['<@111> said hi', '<@111> said bye', '<@111> said ok'].entries()) {
      await addFacts([typed(text, ['message'], { messageIds: [`m${index}`] })]);
    }
    const rules = await recallForSearches([{ query: 'hosting', type: 'rule' }], 'guild');
    expect(rules.map((fact) => fact.text)).toEqual(['<@111> hosts on Fridays']);
  });

  it('still finds a fact nobody has typed, whichever type is asked for', async () => {
    state.distance.different = 0.5;
    await addFacts([candidate('<@111> hosts on Fridays')]);
    const rules = await recallForSearches([{ query: 'hosting', type: 'rule' }], 'guild');
    // The whole store looked like this before types existed; a filter that hid
    // it would lose the lot until the cleanup pass runs.
    expect(rules.map((fact) => fact.text)).toEqual(['<@111> hosts on Fridays']);
  });

  it('merges what several searches find, keeping the best distance and every search that wanted it', async () => {
    state.distance.different = 0.5;
    await addFacts([typed('<@111> hosts on Fridays', ['rule', 'message'])]);
    const found = await recallForSearches([
      { query: 'hosting', type: 'rule' },
      { query: 'what <@111> said', type: 'message' },
    ], 'guild');
    expect(found).toHaveLength(1);
    expect(found[0].foundBy).toEqual(['rule: hosting', 'message: what <@111> said']);
  });

  it('gives each search its own type’s budget', async () => {
    state.distance.different = 0.5;
    for (let index = 0; index < 14; index += 1) {
      await addFacts([typed(`<@111> said thing ${index}`, ['message'], { messageIds: [`m${index}`] })]);
    }
    // `message` ships with a bigger budget than the global 8, because once it is
    // most of the store a smaller one is the whole answer.
    expect(await recallForSearches([{ query: 'things said', type: 'message' }], 'guild')).toHaveLength(12);
    expect(await recallForSearches([{ query: 'things said' }], 'guild')).toHaveLength(8);
  });

  it('ignores an empty query rather than searching for nothing', async () => {
    await addFacts([candidate('<@111> owns a dog')]);
    state.embedDocuments.mockClear();
    expect(await recallForSearches([{ query: '   ' }], 'guild')).toEqual([]);
    expect(state.embedDocuments).not.toHaveBeenCalled();
  });

  it('answers nothing at all while a re-embed is still filling the store', async () => {
    await addFacts([candidate('<@111> owns a dog')]);
    state.recallPaused = true;
    expect(await recallForSearches([{ query: 'dogs' }], 'guild')).toEqual([]);
  });
});
