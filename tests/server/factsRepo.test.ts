import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactCandidate } from '../../src/server/db/repositories/factsRepo';

const state = vi.hoisted(() => {
  const rows = new Map<string, { id: string; document: string; metadata: Record<string, unknown> }>();
  const queries: string[] = [];
  const distance = { different: 1 };
  const collection = {
    get: vi.fn(async ({ ids }: { ids?: string[] } = {}) => {
      const found = [...rows.values()].filter((row) => !ids || ids.includes(row.id));
      return { ids: found.map((row) => row.id), rows: () => found };
    }),
    query: vi.fn(async ({ queryEmbeddings }: { queryEmbeddings: number[][] }) => {
      const text = queries[queryEmbeddings[0][0]];
      const found = [...rows.values()].map((row) => ({
        ...row, distance: row.document.toLowerCase() === text.toLowerCase() ? 0 : distance.different,
      })).sort((a, b) => a.distance - b.distance).slice(0, 1);
      return { rows: () => [found] };
    }),
    add: vi.fn(async (args: { ids: string[]; documents: string[]; metadatas: Record<string, unknown>[] }) => {
      for (const [index, id] of args.ids.entries()) rows.set(id, { id, document: args.documents[index], metadata: args.metadatas[index] });
    }),
    update: vi.fn(async (args: { ids: string[]; documents?: string[]; metadatas: Record<string, unknown>[] }) => {
      for (const [index, id] of args.ids.entries()) {
        const old = rows.get(id)!;
        rows.set(id, { id, document: args.documents?.[index] ?? old.document, metadata: args.metadatas[index] });
      }
    }),
    delete: vi.fn(async ({ ids }: { ids: string[] }) => { for (const id of ids) rows.delete(id); }),
  };
  return { rows, queries, distance, collection, embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])) };
});

vi.mock('../../src/server/db/chroma', () => ({ getFactsCollection: async () => state.collection }));
vi.mock('../../src/server/db/repositories/settingsRepo', () => ({ getSettings: () => ({ duplicateDistance: 25 }) }));
vi.mock('../../src/server/ai/embeddings', () => ({
  embedDocuments: state.embedDocuments,
  embedQuery: async (text: string) => [state.queries.push(text) - 1],
}));
vi.mock('../../src/server/ai/queryRewrite', () => ({ rewriteForFactSearch: async (text: string) => text }));
vi.mock('../../src/server/ai/dateEnforcement', () => ({ hasUnresolvedRelativeDate: () => false }));

import { addFacts, deleteFact, listFactsPage } from '../../src/server/db/repositories/factsRepo';
import { withAIRequestBudget } from '../../src/server/ai/requestBudget';

const candidate = (text: string, overrides: Partial<FactCandidate> = {}): FactCandidate => ({
  text, messageIds: ['message-1'], authorIds: ['author-1'], guildId: 'guild', channelId: 'channel',
  referencedFactIds: ['reference-1'], source: 'auto', timePeriodStart: 100, timePeriodEnd: 200, ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.rows.clear();
  state.queries.length = 0;
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

  it('indexes people mentioned in a fact as well as the source author', async () => {
    const [id] = await addFacts([candidate('<@222> owns a dog', { authorIds: ['111'] })]);
    expect(state.rows.get(id)?.metadata.authorIds).toEqual(['111', '222']);
    expect((await listFactsPage({ page: 1, pageSize: 10, authorId: '222' })).facts.map((fact) => fact.id)).toEqual([id]);
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

  it('replaces semantically matching wording using the same ID and one update', async () => {
    const [id] = await addFacts([candidate('The meeting is on Monday')]);
    state.distance.different = 0.1;
    const saved = await addFacts([candidate('The meeting moved to Tuesday', { messageIds: ['message-2'] })]);
    expect(saved).toEqual([id]);
    expect(state.rows.get(id)?.document).toBe('The meeting moved to Tuesday');
    expect(state.rows.get(id)?.metadata.messageIds).toEqual(['message-1', 'message-2']);
    expect(state.collection.delete).not.toHaveBeenCalled();
    expect(state.collection.update).toHaveBeenCalledWith(expect.objectContaining({
      ids: [id], documents: ['The meeting moved to Tuesday'], embeddings: [[1, 0]],
    }));
  });

  it('preserves the original when replacement embedding fails', async () => {
    const [id] = await addFacts([candidate('Original')]);
    state.embedDocuments.mockRejectedValueOnce(new Error('Gemini unavailable'));
    await expect(addFacts([candidate('Replacement')])).rejects.toThrow('Gemini unavailable');
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
