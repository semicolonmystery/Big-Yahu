import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fact } from '../../src/shared/types';

interface UpdateArgs {
  ids: string[];
  documents?: string[];
  embeddings?: number[][];
  metadatas: Array<Record<string, unknown>>;
}

const state = vi.hoisted(() => ({
  structured: vi.fn<(task: string, request: { user: string }) => Promise<unknown>>(),
  facts: [] as Fact[],
  update: vi.fn<(args: {
    ids: string[]; documents?: string[]; embeddings?: number[][]; metadatas: Array<Record<string, unknown>>;
  }) => Promise<void>>(),
  embed: vi.fn(async (texts: string[]) => texts.map((_text, index) => [index])),
  messages: [] as Array<{ messageId: string; authorId: string; content: string }>,
}));

vi.mock('../../src/server/ai/structured', () => ({ structured: state.structured }));
vi.mock('../../src/server/db/chroma', () => ({
  collectionFor: async () => ({ update: state.update }),
  collectionNameFor: () => 'facts__test__3',
}));
vi.mock('../../src/server/ai/embeddings', () => ({
  activeEmbedding: () => ({ model: 'test/embeddings', dimensions: 3 }),
  embedWith: state.embed,
}));
vi.mock('../../src/server/db/repositories/factsRepo', () => ({
  embeddingText: (text: string) => text,
  ensureFactIndex: async () => {},
  factsByIds: async (ids: string[]) => state.facts.filter((fact) => ids.includes(fact.id)),
}));
vi.mock('../../src/server/db/repositories/cachedMessagesRepo', () => ({
  getMessages: (ids: string[]) => state.messages.filter((message) => ids.includes(message.messageId)),
}));
vi.mock('../../src/server/db/repositories/promptsRepo', () => ({ effectivePrompt: () => 'CLEAN THESE UP' }));

import { db } from '../../src/server/db/client';
import { factTypes, reembedJobItems, reembedJobs, settings } from '../../src/server/db/schema';
import { cleanupBatch, startCleanup, UNTYPED_FILTER } from '../../src/server/ai/factCleanup';
import { createJob, jobById } from '../../src/server/db/repositories/reembedRepo';
import { indexFacts } from '../../src/server/db/repositories/factIndexRepo';
import { factIndex } from '../../src/server/db/schema';

const fact = (id: string, text: string, types: string[] = [], messageIds: string[] = []): Fact => ({
  id,
  text,
  metadata: {
    guildId: 'guild', channelId: 'channel', messageIds, authorIds: ['111'], subjectIds: [], channelRefs: [],
    types, referencedFactIds: [], timePeriodStart: 0, timePeriodEnd: 0, source: 'auto', createdAt: 1_700_000_000_000,
  },
});

const openCleanup = (ids: string[], bundleSize = 10) => createJob({
  kind: 'cleanup', typeFilter: '', bundleSize,
  sourceModel: 'test/embeddings', sourceDimensions: 3, sourceCollection: 'facts__test__3',
  targetModel: 'test/embeddings', targetDimensions: 3, targetCollection: 'facts__test__3',
  pausesRecall: false,
}, ids);

const answered = (facts: Array<Partial<{ id: string; text: string; types: string[]; changed: boolean; needsSources: boolean }>>) =>
  ({ facts: facts.map((entry) => ({ types: [], changed: true, needsSources: false, ...entry })) });

beforeEach(() => {
  for (const table of [reembedJobItems, reembedJobs, factIndex, factTypes, settings]) db.delete(table).run();
  state.facts = [];
  state.messages = [];
  vi.clearAllMocks();
  state.update.mockResolvedValue(undefined);
  state.embed.mockImplementation(async (texts: string[]) => texts.map((_text, index) => [index]));
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

describe('rewriting a bundle', () => {
  it('writes only the facts the model actually changed', async () => {
    state.facts = [fact('a', 'the meeting is tomorrow'), fact('b', 'Alice owns a dog')];
    const job = openCleanup(['a', 'b']);
    state.structured.mockResolvedValueOnce(answered([
      { id: 'a', text: 'the meeting is on 11.9.2026', types: ['event'] },
      // Returned exactly as it came: the honest majority answer.
      { id: 'b', text: 'Alice owns a dog', types: [], changed: false },
    ]));
    await cleanupBatch(job, ['a', 'b']);

    expect(state.update).toHaveBeenCalledTimes(1);
    expect(state.update.mock.calls[0][0]).toMatchObject({
      ids: ['a'], documents: ['the meeting is on 11.9.2026'],
    });
    expect(jobById(job.id)?.copied).toBe(2);
  });

  it('re-embeds a fact whose wording changed, because its old vector describes a sentence that is gone', async () => {
    state.facts = [fact('a', 'the meeting is tomorrow')];
    const job = openCleanup(['a']);
    state.structured.mockResolvedValueOnce(answered([{ id: 'a', text: 'the meeting is on 11.9.2026', types: ['event'] }]));
    await cleanupBatch(job, ['a']);

    expect(state.embed).toHaveBeenCalledWith(['the meeting is on 11.9.2026'], { model: 'test/embeddings', dimensions: 3 });
    expect(state.update.mock.calls[0][0].embeddings).toHaveLength(1);
  });

  it('sorts a fact into types without touching its wording, and sends no embedding for it', async () => {
    state.facts = [fact('a', 'Alice owns a dog')];
    const job = openCleanup(['a']);
    state.structured.mockResolvedValueOnce(answered([{ id: 'a', text: 'Alice owns a dog', types: ['person'] }]));
    await cleanupBatch(job, ['a']);

    // An empty embedding is refused by Chroma, so the two kinds of change are
    // two writes rather than one with holes in it.
    expect(state.embed).not.toHaveBeenCalled();
    expect(state.update.mock.calls[0][0]).not.toHaveProperty('embeddings');
    expect(state.update.mock.calls[0][0].metadatas[0]).toMatchObject({ types: ['person'] });
  });

  it('drops a type nobody defined rather than storing it', async () => {
    state.facts = [fact('a', 'Alice owns a dog')];
    const job = openCleanup(['a']);
    state.structured.mockResolvedValueOnce(answered([{ id: 'a', text: 'Alice owns a dog', types: ['person', 'invented'] }]));
    await cleanupBatch(job, ['a']);
    expect((state.update.mock.calls[0][0] as UpdateArgs).metadatas[0].types).toEqual(['person']);
  });

  it('ignores an id the model invented, and a fact it forgot to answer for', async () => {
    state.facts = [fact('a', 'one'), fact('b', 'two')];
    const job = openCleanup(['a', 'b']);
    state.structured.mockResolvedValueOnce(answered([
      { id: 'a', text: 'one corrected', types: ['info'] },
      { id: 'ghost', text: 'something else entirely', types: ['info'] },
    ]));
    await cleanupBatch(job, ['a', 'b']);

    expect(state.update.mock.calls[0][0].ids).toEqual(['a']);
    // Both are done: the one it answered for and the one it quietly dropped.
    expect(jobById(job.id)?.copied).toBe(2);
  });

  // This job rewrites every fact the bot owns. A model having a bad minute must
  // not leave a batch cycling forever, and must never half-write one.
  it('changes nothing and moves on when the call fails outright', async () => {
    state.facts = [fact('a', 'one'), fact('b', 'two')];
    const job = openCleanup(['a', 'b']);
    state.structured.mockRejectedValueOnce(new Error('the model fell over'));
    await cleanupBatch(job, ['a', 'b']);

    expect(state.update).not.toHaveBeenCalled();
    expect(jobById(job.id)?.copied).toBe(2);
  });

  it('marks facts that vanished between the snapshot and now as done, not stuck', async () => {
    const job = openCleanup(['gone']);
    await cleanupBatch(job, ['gone']);
    expect(state.structured).not.toHaveBeenCalled();
    expect(jobById(job.id)?.copied).toBe(1);
  });
});

describe('asking for the messages behind a fact', () => {
  it('asks again with the sources, and keeps the second answer', async () => {
    state.facts = [fact('a', 'he said it tomorrow', [], ['m1']), fact('b', 'Alice owns a dog')];
    state.messages = [{ messageId: 'm1', authorId: '111', content: 'matěj říkal že je teplej' }];
    const job = openCleanup(['a', 'b']);
    state.structured
      .mockResolvedValueOnce(answered([
        { id: 'a', text: 'he said it tomorrow', changed: false, needsSources: true },
        { id: 'b', text: 'Alice owns a dog', changed: false },
      ]))
      .mockResolvedValueOnce(answered([{ id: 'a', text: '<@111> said <@222> is gay', types: ['message'] }]));
    await cleanupBatch(job, ['a', 'b']);

    expect(state.structured).toHaveBeenCalledTimes(2);
    // Only the fact that asked goes back, with its messages attached.
    const second = JSON.parse(state.structured.mock.calls[1][1].user) as { facts: Array<{ sources?: unknown }> };
    expect(second.facts).toHaveLength(1);
    expect(second.facts[0].sources).toEqual([{ authorId: '111', content: 'matěj říkal že je teplej' }]);
    expect(state.update.mock.calls[0][0]).toMatchObject({ ids: ['a'], documents: ['<@111> said <@222> is gay'] });
  });

  it('asks only once, so a model that keeps asking cannot loop', async () => {
    state.facts = [fact('a', 'he said it tomorrow', [], ['m1'])];
    state.messages = [{ messageId: 'm1', authorId: '111', content: 'said something' }];
    const job = openCleanup(['a']);
    state.structured.mockResolvedValue(answered([{ id: 'a', text: 'he said it tomorrow', changed: false, needsSources: true }]));
    await cleanupBatch(job, ['a']);
    expect(state.structured).toHaveBeenCalledTimes(2);
  });

  it('does not attach sources to a fact that did not ask', async () => {
    state.facts = [fact('a', 'one', [], ['m1'])];
    state.messages = [{ messageId: 'm1', authorId: '111', content: 'the original' }];
    const job = openCleanup(['a']);
    state.structured.mockResolvedValueOnce(answered([{ id: 'a', text: 'one', changed: false }]));
    await cleanupBatch(job, ['a']);
    const first = JSON.parse(state.structured.mock.calls[0][1].user) as { facts: Array<Record<string, unknown>> };
    expect(first.facts[0]).not.toHaveProperty('sources');
  });
});

describe('choosing what to go over', () => {
  it('snapshots the untyped ones, which Chroma cannot select on its own', async () => {
    indexFacts([fact('a', 'untyped one'), fact('b', 'typed one', ['rule'])]);
    const job = await startCleanup([UNTYPED_FILTER], 5);
    expect(job?.total).toBe(1);
    expect(job?.kind).toBe('cleanup');
  });

  it('snapshots one type, so a run can skip the enormous message set', async () => {
    indexFacts([fact('a', 'a rule', ['rule']), fact('b', 'a message', ['message'])]);
    const job = await startCleanup(['rule'], 5);
    expect(job?.total).toBe(1);
  });

  it('goes over everything when nothing is named', async () => {
    indexFacts([fact('a', 'untyped one'), fact('b', 'a rule', ['rule'])]);
    expect((await startCleanup([], 5))?.total).toBe(2);
  });

  it('starts nothing when there is nothing to do, or when a job is already open', async () => {
    expect(await startCleanup(['rule'], 5)).toBeNull();
    indexFacts([fact('a', 'a rule', ['rule'])]);
    expect(await startCleanup(['rule'], 5)).not.toBeNull();
    expect(await startCleanup(['rule'], 5)).toBeNull();
  });

  it('holds the bundle size inside its bounds', async () => {
    indexFacts([fact('a', 'a rule', ['rule'])]);
    expect((await startCleanup(['rule'], 900))?.bundleSize).toBe(50);
  });
});
