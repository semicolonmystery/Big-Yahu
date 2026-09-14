import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  interface Row { id: string; document: string; metadata: Record<string, unknown>; embedding?: number[] }
  const store = new Map<string, Map<string, Row>>();
  const deleted: string[] = [];
  const embedCalls: string[][] = [];
  const fail = { onEmbed: false };

  const handle = (name: string) => {
    const rows = store.get(name) ?? new Map<string, Row>();
    store.set(name, rows);
    return {
      count: async () => rows.size,
      get: async ({ ids, limit, offset = 0 }: { ids?: string[]; limit?: number; offset?: number } = {}) => {
        const all = [...rows.values()];
        const found = ids ? all.filter((row) => ids.includes(row.id)) : all.slice(offset, offset + (limit ?? all.length));
        return { ids: found.map((row) => row.id), rows: () => found };
      },
      upsert: async (args: { ids: string[]; documents: string[]; metadatas: Record<string, unknown>[]; embeddings: number[][] }) => {
        args.ids.forEach((id, index) => rows.set(id, {
          id, document: args.documents[index], metadata: args.metadatas[index], embedding: args.embeddings[index],
        }));
      },
      delete: async ({ ids }: { ids: string[] }) => { for (const id of ids) rows.delete(id); },
    };
  };

  return {
    store, deleted, embedCalls, fail, handle,
    /** Hook for acting while the loop is between batches. */
    afterBatch: null as (() => void) | null,
    forgetCollections: vi.fn(),
  };
});

vi.mock('../../src/server/db/chroma', () => ({
  chroma: {
    listCollections: async () => [...state.store.keys()].map((name) => ({ name })),
    getCollection: async ({ name }: { name: string }) => {
      if (!state.store.has(name)) throw new Error(`no collection ${name}`);
      return state.handle(name);
    },
    deleteCollection: async ({ name }: { name: string }) => {
      state.deleted.push(name);
      state.store.delete(name);
    },
  },
  collectionFor: async (config: { model: string; dimensions: number }) => state.handle(`facts__${config.model}__${config.dimensions}`),
  collectionNameFor: (config: { model: string; dimensions: number }) => `facts__${config.model}__${config.dimensions}`,
  forgetCollections: state.forgetCollections,
}));

vi.mock('../../src/server/ai/embeddings', () => ({
  configuredEmbedding: () => ({ model: 'new/model', dimensions: 4 }),
  embedWith: async (texts: string[]) => {
    state.embedCalls.push(texts);
    if (state.fail.onEmbed) throw new Error('provider is down');
    state.afterBatch?.();
    return texts.map(() => [1, 0, 0, 0]);
  },
}));

import { db } from '../../src/server/db/client';
import { reembedJobItems, reembedJobs, settings } from '../../src/server/db/schema';
import { getActiveEmbedding, setActiveEmbedding } from '../../src/server/db/repositories/settingsRepo';
import {
  dropFromSnapshot, jobById, markCopied, noteFactsChanged, openJob, pendingFactIds, recallIsPaused,
} from '../../src/server/db/repositories/reembedRepo';
import {
  continueReembed, pauseReembed, planReembed, resetReembed, resumeReembedAtBoot, runReembed, startReembed,
} from '../../src/server/ai/reembed';

const LEGACY = 'facts';
const TARGET = 'facts__new/model__4';

function seedLegacy(count: number) {
  const rows = new Map();
  for (let index = 0; index < count; index += 1) {
    rows.set(`fact-${index}`, {
      id: `fact-${index}`, document: `<@111> said something ${index}`, metadata: { guildId: 'guild', channelId: 'c' },
    });
  }
  state.store.set(LEGACY, rows);
}

beforeEach(() => {
  db.delete(reembedJobItems).run();
  db.delete(reembedJobs).run();
  db.delete(settings).run();
  state.store.clear();
  state.deleted.length = 0;
  state.embedCalls.length = 0;
  state.fail.onEmbed = false;
  state.afterBatch = null;
  state.forgetCollections.mockClear();
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

describe('planning a move', () => {
  it('reads the collection that predates per-model names when nothing has been embedded yet', async () => {
    seedLegacy(3);
    const plan = await planReembed();
    expect(plan.upToDate).toBe(false);
    expect(plan.source).toMatchObject({ collection: LEGACY, exists: true, facts: 3 });
    expect(plan.target).toMatchObject({ collection: TARGET, model: 'new/model', dimensions: 4 });
  });

  it('has nothing to do once the store is on the configured pair', async () => {
    setActiveEmbedding('new/model', 4);
    state.store.set(TARGET, new Map());
    expect((await planReembed()).upToDate).toBe(true);
  });
});

describe('moving the facts', () => {
  it('copies every fact, swaps recall over and drops the old collection', async () => {
    seedLegacy(5);
    await startReembed();
    await runReembed();

    expect(state.store.get(TARGET)?.size).toBe(5);
    // Re-embedded with the new model rather than copied across as they were.
    expect(state.embedCalls.flat()).toHaveLength(5);
    expect(getActiveEmbedding()).toEqual({ model: 'new/model', dimensions: 4 });
    expect(state.forgetCollections).toHaveBeenCalled();
    expect(state.deleted).toEqual([LEGACY]);
    expect(openJob()).toBeUndefined();
  });

  it('embeds the text without ids, while storing the fact as it was written', async () => {
    seedLegacy(1);
    await startReembed();
    await runReembed();
    expect(state.embedCalls.flat()).toEqual(['someone said something 0']);
    expect(state.store.get(TARGET)?.get('fact-0')?.document).toBe('<@111> said something 0');
  });

  it('pauses recall for the first move, because there is nothing to search yet', async () => {
    seedLegacy(2);
    await startReembed();
    expect(recallIsPaused()).toBe(true);
    await runReembed();
    expect(recallIsPaused()).toBe(false);
  });

  it('leaves recall alone when there is already a collection to search', async () => {
    setActiveEmbedding('old/model', 3);
    state.store.set('facts__old/model__3', new Map([['fact-0', { id: 'fact-0', document: 'a fact', metadata: {} }]]));
    await startReembed();
    expect(recallIsPaused()).toBe(false);
  });
});

describe('when it goes wrong', () => {
  it('keeps what it copied, deletes nothing, and resumes from there', async () => {
    seedLegacy(80);
    await startReembed();
    state.fail.onEmbed = true;
    await runReembed();

    const stopped = db.select().from(reembedJobs).get();
    expect(stopped?.status).toBe('failed');
    expect(stopped?.lastError).toContain('provider is down');
    // The old collection is the only copy of these facts until the swap.
    expect(state.deleted).toEqual([]);
    expect(getActiveEmbedding().model).toBe('');

    state.fail.onEmbed = false;
    db.update(reembedJobs).set({ status: 'running' }).run();
    await runReembed();
    expect(state.store.get(TARGET)?.size).toBe(80);
    expect(state.deleted).toEqual([LEGACY]);
  });

  it('refuses to swap, and keeps the old collection, when a fact did not make it across', async () => {
    seedLegacy(3);
    const job = await startReembed();
    // Marked as done without ever arriving — the failure a count would miss,
    // since the job believes it moved everything it promised.
    markCopied(job!.id, ['fact-2']);
    await runReembed();

    const stopped = db.select().from(reembedJobs).get();
    expect(stopped?.status).toBe('failed');
    expect(stopped?.lastError).toContain('fact-2');
    expect(state.deleted).toEqual([]);
    expect(getActiveEmbedding().model).toBe('');
  });

  it('is not fooled by a target holding the same number of different facts', async () => {
    seedLegacy(2);
    const job = await startReembed();
    state.store.set(TARGET, new Map([
      ['other-a', { id: 'other-a', document: 'not ours', metadata: {} }],
      ['other-b', { id: 'other-b', document: 'not ours either', metadata: {} }],
    ]));
    markCopied(job!.id, ['fact-0', 'fact-1']);
    await runReembed();

    expect(db.select().from(reembedJobs).get()?.status).toBe('failed');
    expect(state.deleted).toEqual([]);
  });

  it('does not start a second job while one is running', async () => {
    seedLegacy(3);
    const first = await startReembed();
    expect((await startReembed())?.id).toBe(first?.id);
    expect(db.select().from(reembedJobs).all()).toHaveLength(1);
  });
});

describe('the store changing under a running job', () => {
  it('moves a fact written after the snapshot was taken', async () => {
    setActiveEmbedding('old/model', 3);
    const source = 'facts__old/model__3';
    state.store.set(source, new Map([['fact-0', { id: 'fact-0', document: 'first', metadata: {} }]]));
    await startReembed();

    state.store.get(source)!.set('later', { id: 'later', document: 'written mid-move', metadata: {} });
    noteFactsChanged(source, ['later']);
    await runReembed();

    expect(state.store.get(TARGET)?.size).toBe(2);
    expect(state.store.get(TARGET)?.get('later')?.document).toBe('written mid-move');
  });

  it('queues a fact again when its wording changed after it was already moved', async () => {
    setActiveEmbedding('old/model', 3);
    const source = 'facts__old/model__3';
    state.store.set(source, new Map([
      ['fact-0', { id: 'fact-0', document: 'first wording', metadata: {} }],
      ['fact-1', { id: 'fact-1', document: 'untouched', metadata: {} }],
    ]));
    const job = await startReembed();
    markCopied(job!.id, ['fact-0', 'fact-1']);
    expect(jobById(job!.id)?.copied).toBe(2);

    // The copy in the target is now the old wording, so it has to go again.
    noteFactsChanged(source, ['fact-0']);
    expect(jobById(job!.id)).toMatchObject({ copied: 1, total: 2 });
    expect(pendingFactIds(job!.id, 10)).toEqual(['fact-0']);

    state.store.get(source)!.set('fact-0', { id: 'fact-0', document: 'second wording', metadata: {} });
    await runReembed();
    expect(state.store.get(TARGET)?.get('fact-0')?.document).toBe('second wording');
  });

  it('does not bring back a fact deleted while the job was running', async () => {
    seedLegacy(2);
    await startReembed();
    state.store.get(LEGACY)!.delete('fact-1');
    dropFromSnapshot('fact-1');
    await runReembed();

    expect([...(state.store.get(TARGET)?.keys() ?? [])]).toEqual(['fact-0']);
    expect(db.select().from(reembedJobs).get()?.status).toBe('complete');
  });
});

describe('nothing starts on its own', () => {
  it('leaves facts on the old model at boot, and says how to move them', async () => {
    seedLegacy(4);
    await resumeReembedAtBoot();

    expect(db.select().from(reembedJobs).all()).toEqual([]);
    expect(state.embedCalls).toEqual([]);
    // Untouched, and still the only copy.
    expect(state.store.get(LEGACY)?.size).toBe(4);
    expect(getActiveEmbedding().model).toBe('');
  });

  it('starts only when the button is pressed', async () => {
    seedLegacy(4);
    await resumeReembedAtBoot();
    await startReembed();
    await runReembed();
    expect(state.store.get(TARGET)?.size).toBe(4);
  });

  it('carries on a job that was running when the process stopped', async () => {
    seedLegacy(2);
    await startReembed();
    await resumeReembedAtBoot();
    await runReembed();
    expect(db.select().from(reembedJobs).get()?.status).toBe('complete');
  });

  it('leaves a paused job paused across a restart', async () => {
    seedLegacy(2);
    await startReembed();
    pauseReembed();
    await resumeReembedAtBoot();
    await runReembed();

    expect(db.select().from(reembedJobs).get()).toMatchObject({ status: 'paused', copied: 0 });
    expect(state.embedCalls).toEqual([]);
  });

  it('settles the collection name without a job when there is nothing stored yet', async () => {
    state.store.set(LEGACY, new Map());
    await resumeReembedAtBoot();
    expect(getActiveEmbedding()).toEqual({ model: 'new/model', dimensions: 4 });
    expect(db.select().from(reembedJobs).all()).toEqual([]);
  });
});

describe('pause, continue and reset', () => {
  it('stops at a batch boundary and keeps what it copied', async () => {
    seedLegacy(120);
    await startReembed();
    state.afterBatch = () => { pauseReembed(); state.afterBatch = null; };
    await runReembed();

    const job = db.select().from(reembedJobs).get();
    expect(job?.status).toBe('paused');
    // One batch across, the rest still waiting; nothing half-written.
    expect(job?.copied).toBe(50);
    expect(state.store.get(TARGET)?.size).toBe(50);
    expect(state.deleted).toEqual([]);
  });

  it('continues from the cursor without paying for the same facts twice', async () => {
    seedLegacy(120);
    await startReembed();
    state.afterBatch = () => { pauseReembed(); state.afterBatch = null; };
    await runReembed();
    state.embedCalls.length = 0;

    continueReembed();
    await runReembed();
    expect(state.embedCalls.flat()).toHaveLength(70);
    expect(db.select().from(reembedJobs).get()?.status).toBe('complete');
  });

  it('resets back to the originals, taking out only what the job put there', async () => {
    setActiveEmbedding('old/model', 3);
    const source = 'facts__old/model__3';
    state.store.set(source, new Map([
      ['fact-0', { id: 'fact-0', document: 'first', metadata: {} }],
      ['fact-1', { id: 'fact-1', document: 'second', metadata: {} }],
    ]));
    await startReembed();
    // Paused after the copy but before the swap, which is when a reset is a
    // real question: the facts are in both places.
    state.afterBatch = () => { pauseReembed(); state.afterBatch = null; };
    await runReembed();
    expect(state.store.get(TARGET)?.size).toBe(2);

    // A fact saved into the new collection that was never part of the move.
    state.store.get(TARGET)!.set('fresh', { id: 'fresh', document: 'saved meanwhile', metadata: {} });
    expect(await resetReembed()).toBe(true);

    expect([...(state.store.get(TARGET)?.keys() ?? [])]).toEqual(['fresh']);
    expect(state.store.get(source)?.size).toBe(2);
    expect(state.deleted).toEqual([]);
    expect(db.select().from(reembedJobs).all()).toEqual([]);
  });

  it('can be started again after a reset', async () => {
    seedLegacy(3);
    await startReembed();
    pauseReembed();
    await resetReembed();
    await startReembed();
    await runReembed();
    expect(state.store.get(TARGET)?.size).toBe(3);
  });
});
