import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from 'openai';

const client = vi.hoisted(() => ({
  embeddings: [] as Array<(params: Record<string, any>, options: { signal?: AbortSignal }) => unknown>,
  calls: [] as Array<{ params: Record<string, any>; signal?: AbortSignal }>,
}));

vi.mock('../../src/server/ai/openrouter', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/server/ai/openrouter')>(),
  openrouter: () => ({
    embeddings: {
      create: async (params: Record<string, any>, options: { signal?: AbortSignal } = {}) => {
        client.calls.push({ params, signal: options.signal });
        options.signal?.throwIfAborted();
        const next = client.embeddings.shift();
        if (!next) throw new Error('no embedding reply queued');
        return next(params, options);
      },
    },
  }),
}));

import { db } from '../../src/server/db/client';
import { aiUsage, settings } from '../../src/server/db/schema';
import { updateSettings } from '../../src/server/db/repositories/settingsRepo';
import { embedDocuments, embedQuery } from '../../src/server/ai/embeddings';
import { BillingError, OverloadedError } from '../../src/server/ai/errors';
import { retryDelay } from '../../src/server/ai/retry';
import { AIRequestBudgetError, claimAIRequest, withAIRequestBudget } from '../../src/server/ai/requestBudget';

const DIMENSIONS = 1536;
const vector = () => [3, 4, ...Array<number>(DIMENSIONS - 2).fill(0)];
const answer = (count: number) => () => ({
  data: Array.from({ length: count }, (_, index) => ({ index, embedding: vector() })),
  usage: { prompt_tokens: 10, total_tokens: 10, cost: 0.0000001 },
});
const fails = (status: number, message: string) => () => {
  throw APIError.generate(status, { error: { code: status, message } }, undefined, new Headers());
};

/**
 * `AbortSignal.timeout` runs on Node's internal timers, which fake timers do not
 * touch, so the deadlines are fired by hand instead of waited out.
 */
const deadlines: Array<{ ms: number; fire: () => void }> = [];
function stubDeadlines(): void {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    deadlines.push({ ms, fire: () => controller.abort(new DOMException('TimeoutError', 'TimeoutError')) });
    return controller.signal;
  });
}
/** The most recent one, so a second reply's deadline is not shadowed by the first. */
const deadlineOf = (ms: number) => deadlines.findLast((entry) => entry.ms === ms);

beforeEach(() => {
  deadlines.length = 0;
  client.embeddings = [];
  client.calls = [];
  db.delete(settings).run();
  db.delete(aiUsage).run();
  updateSettings({ retryAttempts: 0, retryDelayMs: 0 });
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('embedding requests', () => {
  it('asks for the configured width and hands back unit vectors in the order given', async () => {
    client.embeddings.push(() => ({
      data: [{ index: 1, embedding: vector() }, { index: 0, embedding: [0, 5, ...Array<number>(DIMENSIONS - 2).fill(0)] }],
      usage: { cost: 0.0000002 },
    }));
    const [first, second] = await embedDocuments(['one', 'two']);

    expect(client.calls[0].params).toMatchObject({ model: 'openai/text-embedding-3-large', dimensions: DIMENSIONS, input: ['one', 'two'] });
    // Answers come back by index, not by arrival: pairing them wrongly would
    // silently file every fact under somebody else's vector.
    expect(first[1]).toBeCloseTo(1);
    expect(Math.hypot(...second)).toBeCloseTo(1);
  });

  it('splits a long batch and records what each request was billed', async () => {
    client.embeddings.push(answer(100), answer(20));
    await embedDocuments(Array.from({ length: 120 }, (_, index) => `fact ${index}`));

    expect(client.calls.map((call) => call.params.input.length)).toEqual([100, 20]);
    expect(db.select().from(aiUsage).all()).toHaveLength(2);
  });

  it('does no paid work for an empty batch', async () => {
    expect(await embedDocuments([])).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it('refuses an answer that is the wrong width, or not a number', async () => {
    client.embeddings.push(() => ({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
    await expect(embedQuery('short')).rejects.toThrow('unusable embedding');

    client.embeddings.push(() => ({ data: [{ index: 0, embedding: [Number.NaN, ...Array<number>(DIMENSIONS - 1).fill(1)] }] }));
    await expect(embedQuery('not a number')).rejects.toThrow('unusable embedding');
  });

  it('retries a transient failure and gives up as overload', async () => {
    updateSettings({ retryAttempts: 1, retryDelayMs: 0 });
    client.embeddings.push(fails(503, 'busy'), answer(1));
    expect(await embedQuery('once more')).toHaveLength(DIMENSIONS);

    client.embeddings.push(fails(503, 'busy'), fails(503, 'busy'));
    await expect(embedQuery('never')).rejects.toBeInstanceOf(OverloadedError);
  });

  it('stops at once when the key is out of credit, and never retries a bad request', async () => {
    client.embeddings.push(fails(402, 'Insufficient credits'));
    await expect(embedQuery('no money')).rejects.toBeInstanceOf(BillingError);

    updateSettings({ retryAttempts: 3 });
    client.embeddings.push(fails(400, 'Model openai/nope does not exist'));
    await expect(embedQuery('bad model')).rejects.toMatchObject({ status: 400 });
    // One attempt each: neither is worth waiting out.
    expect(client.calls).toHaveLength(2);
  });
});

describe('per-reply admission and deadlines', () => {
  it('admits a bounded number of paid attempts across asynchronous work', async () => {
    await withAIRequestBudget(async () => {
      for (let attempt = 0; attempt < 24; attempt += 1) claimAIRequest();
      expect(() => claimAIRequest()).toThrow(AIRequestBudgetError);
    });
  });

  it('keeps simultaneous replies independent', async () => {
    await Promise.all([
      withAIRequestBudget(async () => {
        for (let attempt = 0; attempt < 24; attempt += 1) claimAIRequest();
      }),
      withAIRequestBudget(async () => {
        expect(() => claimAIRequest()).not.toThrow();
      }),
    ]);
  });

  it('shares one budget between embeddings and everything else', async () => {
    client.embeddings.push(answer(1));
    await withAIRequestBudget(async () => {
      await embedQuery('one');
      for (let attempt = 1; attempt < 24; attempt += 1) claimAIRequest();
      expect(() => claimAIRequest()).toThrow(AIRequestBudgetError);
    });
  });

  it('separates running out of time from running out of attempts', async () => {
    stubDeadlines();
    await expect(withAIRequestBudget(async () => {
      deadlineOf(120_000)?.fire();
      claimAIRequest();
    })).rejects.toThrow('ran out of time');

    await expect(withAIRequestBudget(async () => {
      for (let attempt = 0; attempt < 24; attempt += 1) claimAIRequest();
      claimAIRequest();
    })).rejects.toThrow('exhausted');
  });

  it('combines the reply deadline with a shorter per-attempt one', async () => {
    stubDeadlines();
    await withAIRequestBudget(async () => {
      const signal = claimAIRequest();
      expect(signal.aborted).toBe(false);
      // The attempt gives up long before the reply does, and either one ends it.
      deadlineOf(45_000)?.fire();
      expect(signal.aborted).toBe(true);
    });
    await withAIRequestBudget(async () => {
      const signal = claimAIRequest();
      deadlineOf(120_000)?.fire();
      expect(signal.aborted).toBe(true);
    });
  });

  it('passes the reply deadline into the embedding request itself', async () => {
    client.embeddings.push(answer(1));
    await withAIRequestBudget(async () => {
      await embedQuery('inside a reply');
    });
    expect(client.calls[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('retry backoff', () => {
  it('grows exponentially and is capped', async () => {
    vi.useFakeTimers();
    const waits: number[] = [];
    for (const attempt of [0, 1, 2, 10]) {
      const started = Date.now();
      const pending = retryDelay(1000, attempt).then(() => waits.push(Date.now() - started));
      await vi.advanceTimersByTimeAsync(70_000);
      await pending;
    }
    expect(waits[0]).toBe(1000);
    expect(waits[1]).toBe(2000);
    expect(waits[2]).toBe(4000);
    expect(waits[3]).toBe(60_000);
  });

  it('gives up the moment the reply is cancelled, rather than sleeping it out', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = retryDelay(60_000, 0, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });
});
