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
    get: vi.fn(async ({ ids }: { ids?: string[] } = {}) => {
      const found = [...rows.values()].filter((row) => !ids || ids.includes(row.id));
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
  };
  return {
    rows, distance, distances, collection, index,
    embedDocuments: vi.fn(async (texts: string[]) => texts.map((text) => [index(text)])),
  };
});

vi.mock('../../src/server/db/chroma', () => ({ getFactsCollection: async () => state.collection }));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({ getSettings: () => ({ duplicateDistance: 25 }) }));
vi.mock('../../src/server/ai/embeddings', () => ({
  embedDocuments: state.embedDocuments,
  embedQuery: async (text: string) => [state.index(text)],
}));
vi.mock('../../src/server/ai/dateEnforcement', () => ({ hasUnresolvedRelativeDate: () => false }));

import {
  addFacts, deleteFact, embeddingText, listFactsPage, recallFacts,
} from '../../src/server/db/repositories/factsRepo';
import { withAIRequestBudget } from '../../src/server/ai/requestBudget';

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

  it('keeps another server out of the answer', async () => {
    await addFacts([about('Ours')]);
    await addFacts([about('Theirs', { guildId: 'elsewhere' })]);
    state.distance.different = 0.5;
    const found = await recallFacts({ query: 'anything', topK: 5, guildId: 'guild' });
    expect(found.map((fact) => fact.text)).toEqual(['Ours']);
  });
});
