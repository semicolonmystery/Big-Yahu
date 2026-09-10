import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';

vi.mock('../../src/server/env', () => ({ env: { geminiApiKey: 'test-key-never-sent' } }));
vi.mock('../../src/server/db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const schema = await import('../../src/server/db/schema');
  const db = drizzle(new Database(':memory:'), { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return { db };
});

import { db } from '../../src/server/db/client';
import { chatModels, settings } from '../../src/server/db/schema';
import { addModel, listModels } from '../../src/server/db/repositories/chatModelsRepo';
import { updateSettings } from '../../src/server/db/repositories/settingsRepo';
import { generate, OverloadedError } from '../../src/server/ai/generate';
import { embedDocuments, embedQuery, geminiEmbeddingFunction } from '../../src/server/ai/embeddings';
import { isRetryable, retryDelay } from '../../src/server/ai/retry';
import { AIRequestBudgetError, claimAIRequest, withAIRequestBudget } from '../../src/server/ai/requestBudget';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../../src/shared/constants';

const vector = () => [3, 4, ...Array<number>(EMBEDDING_DIMENSIONS - 2).fill(0)];
const success = () => Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'An answer' }] } }] });
const unavailable = (status = 503) => Response.json({ error: { code: status, message: 'Model unavailable', status: 'UNAVAILABLE' } }, { status });
const transport = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => success());
const payload = (index = 0): Record<string, any> => JSON.parse(String(transport.mock.calls[index][1]?.body));

beforeEach(() => {
  vi.clearAllMocks();
  transport.mockReset();
  transport.mockImplementation(async () => success());
  vi.stubGlobal('fetch', transport);
  db.delete(chatModels).run();
  db.delete(settings).run();
  updateSettings({ retryAttempts: 0, retryDelayMs: 0, modelFailureThreshold: 20 });
  addModel('model-primary', 100);
});
afterEach(() => { vi.useRealTimers(); });
afterAll(() => db.$client.close());

describe('Gemini requests through the real SDK', () => {
  it('does not add hidden SDK retries when application retries are disabled', async () => {
    transport.mockImplementation(async () => unavailable());
    await expect(generate('Question', {})).rejects.toBeInstanceOf(OverloadedError);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(listModels()[0].consecutiveFailures).toBe(1);
  });

  it('falls back to the next model and records failure/success against the correct model', async () => {
    updateSettings({ modelFailureThreshold: 1 });
    addModel('model-backup', 50);
    transport.mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(success());
    expect((await generate('Question', {})).text).toBe('An answer');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(String(transport.mock.calls[0][0])).toContain('model-primary:generateContent');
    expect(String(transport.mock.calls[1][0])).toContain('model-backup:generateContent');
    expect(listModels().map(({ model, consecutiveFailures }) => [model, consecutiveFailures]))
      .toEqual([['model-primary', 1], ['model-backup', 0]]);
    expect(listModels()[0].restingUntil).toBeGreaterThan(Date.now());
    await generate('Another question', {});
    expect(String(transport.mock.calls[2][0])).toContain('model-backup:generateContent');
  });

  it('performs exactly the configured attempts and reports all exhausted models', async () => {
    updateSettings({ retryAttempts: 2 });
    transport.mockImplementation(async () => unavailable());
    await expect(generate('Question', {})).rejects.toMatchObject({
      name: 'OverloadedError', attempts: 3, triedModels: ['model-primary', 'model-primary', 'model-primary'],
    });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('does not retry a bad request or put its model to rest', async () => {
    updateSettings({ retryAttempts: 2 });
    addModel('model-backup', 50);
    transport.mockImplementation(async () => unavailable(400));
    await expect(generate('Question', {})).rejects.toMatchObject({ status: 400 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(listModels().every((model) => model.consecutiveFailures === 0)).toBe(true);
  });

  it('fails before a paid request when the model pool is empty', async () => {
    db.delete(chatModels).run();
    await expect(generate('Question', {})).rejects.toThrow('No chat models are configured');
    expect(transport).not.toHaveBeenCalled();
  });

  // 4096 is the default, not a ceiling: extraction answers a schema over a
  // whole page and needs more, and on thinking models the budget also pays for
  // thinking. Only the runaway bound is fixed.
  it.each([[undefined, 4096], [512, 512], [10_000, 10_000], [32_768, 32_768], [1_000_000, 65_536]])(
    'bounds output tokens (%s → %s)',
    async (requested, expected) => {
      await generate('Question', { maxOutputTokens: requested });
      expect(payload().generationConfig.maxOutputTokens).toBe(expected);
      expect(transport.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    },
  );
});

describe('embedding requests and validation', () => {
  it('uses document batches of at most 100 and normalizes reduced-dimension embeddings', async () => {
    transport.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const count = body.requests?.length ?? 1;
      return Response.json({ embeddings: Array.from({ length: count }, () => ({ values: vector() })) });
    });
    const result = await embedDocuments(Array.from({ length: 201 }, (_, index) => `Fact ${index}`));
    expect(transport).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((index) => payload(index).requests.length)).toEqual([100, 100, 1]);
    expect(result).toHaveLength(201);
    expect(result[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(result[0].slice(0, 2)).toEqual([0.6, 0.8]);
    expect(payload().requests[0]).toMatchObject({
      taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: EMBEDDING_DIMENSIONS,
    });
    expect(String(transport.mock.calls[0][0])).toContain(EMBEDDING_MODEL);
  });

  it('uses query task type and exposes the cosine embedding-function contract', async () => {
    transport.mockResolvedValueOnce(Response.json({ embeddings: [{ values: vector() }] }));
    expect((await embedQuery('Who won?')).slice(0, 2)).toEqual([0.6, 0.8]);
    expect(payload().requests[0].taskType).toBe('RETRIEVAL_QUERY');
    expect(geminiEmbeddingFunction.defaultSpace?.()).toBe('cosine');
    expect(geminiEmbeddingFunction.supportedSpaces?.()).toEqual(['cosine']);
    expect(geminiEmbeddingFunction.getConfig?.()).toEqual({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS });
  });

  it('does no paid work for an empty embedding batch', async () => {
    expect(await embedDocuments([])).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it('retries transient embedding failures without nested SDK retries', async () => {
    updateSettings({ retryAttempts: 1 });
    transport.mockResolvedValueOnce(unavailable(429)).mockResolvedValueOnce(Response.json({ embeddings: [{ values: vector() }] }));
    expect(await embedQuery('Question')).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(listModels()[0].consecutiveFailures).toBe(0);
  });

  it('reports exhausted embeddings as overload and never retries a 400', async () => {
    updateSettings({ retryAttempts: 1 });
    transport.mockImplementation(async () => unavailable());
    await expect(embedQuery('Question')).rejects.toMatchObject({ name: 'OverloadedError', attempts: 2 });
    expect(transport).toHaveBeenCalledTimes(2);
    transport.mockClear();
    transport.mockImplementation(async () => unavailable(400));
    await expect(embedQuery('Question')).rejects.toMatchObject({ status: 400 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { embeddings: [] }, { embeddings: [{ values: vector() }, { values: vector() }] }])
    ('rejects a missing or mismatched embedding count %#', async (response) => {
      transport.mockResolvedValueOnce(Response.json(response));
      await expect(embedQuery('Question')).rejects.toThrow('Expected 1 embeddings');
    });

  it.each([
    undefined, [], [1, 2], Array(EMBEDDING_DIMENSIONS).fill(0),
    [null, ...Array(EMBEDDING_DIMENSIONS - 1).fill(1)],
  ])('rejects invalid embedding dimensions or values %#', async (values) => {
    transport.mockResolvedValueOnce(Response.json({ embeddings: [{ values }] }));
    await expect(embedQuery('Question')).rejects.toThrow('invalid embedding');
  });

  it.each([1e300, 1e-300])('normalizes extreme but finite vectors without overflow or underflow (%s)', async (value) => {
    transport.mockResolvedValueOnce(Response.json({ embeddings: [{ values: [value, ...Array(EMBEDDING_DIMENSIONS - 1).fill(0)] }] }));
    const result = await embedQuery('Question');
    expect(result[0]).toBeCloseTo(1, 10);
  });

  it('rejects a non-finite component received as a JSON number', async () => {
    const body = `{"embeddings":[{"values":[1e999,${Array(EMBEDDING_DIMENSIONS - 1).fill(0).join(',')}]}]}`;
    transport.mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    await expect(embedQuery('Question')).rejects.toThrow('invalid embedding');
  });
});

describe('retry classification and delays', () => {
  it.each([429, 500, 502, 503, 504])('retries transient SDK status %s', (status) => {
    expect(isRetryable(new ApiError({ status, message: 'failure' }))).toBe(true);
  });

  it.each([400, 401, 403, 404])('does not retry permanent SDK status %s', (status) => {
    expect(isRetryable(new ApiError({ status, message: 'unavailable 503 in a bad request' }))).toBe(false);
  });

  it.each(['fetch failed', 'ECONNRESET', 'ETIMEDOUT', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE'])('recognizes transient transport errors: %s', (message) => {
    expect(isRetryable(new Error(message))).toBe(true);
  });

  it('does not retry arbitrary application or admission errors', () => {
    expect(isRetryable(new Error('Malformed payload'))).toBe(false);
    expect(isRetryable(new AIRequestBudgetError('The AI request budget for this reply is exhausted'))).toBe(false);
  });

  it.each(['TimeoutError', 'AbortError'])('recognizes attempt timeout/abort errors: %s', (name) => {
    expect(isRetryable(new DOMException('Attempt stopped', name))).toBe(true);
  });

  it('backs off exponentially and caps an individual wait at 60 seconds', async () => {
    vi.useFakeTimers();
    let complete = false;
    const delay = retryDelay(10_000, 4).then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await delay;
    expect(complete).toBe(true);
  });
});

describe('per-reply request admission and abort signals', () => {
  it('admits exactly 24 attempts across asynchronous work', async () => {
    await withAIRequestBudget(async () => {
      for (let index = 0; index < 24; index += 1) {
        await Promise.resolve();
        expect(claimAIRequest()).toBeInstanceOf(AbortSignal);
      }
      expect(() => claimAIRequest()).toThrow(AIRequestBudgetError);
    });
  });

  it('keeps simultaneous reply budgets independent', async () => {
    await Promise.all(Array.from({ length: 2 }, () => withAIRequestBudget(async () => {
      for (let index = 0; index < 24; index += 1) { claimAIRequest(); await Promise.resolve(); }
      expect(() => claimAIRequest()).toThrow(AIRequestBudgetError);
    })));
  });

  it('shares admission between embeddings and chat without a 25th paid HTTP call', async () => {
    transport.mockResolvedValueOnce(Response.json({ embeddings: [{ values: vector() }] }));
    await withAIRequestBudget(async () => {
      for (let index = 0; index < 23; index += 1) claimAIRequest();
      await embedQuery('Question');
      await expect(generate('Question', {})).rejects.toBeInstanceOf(AIRequestBudgetError);
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('caps fallback and retry attempts at 24 paid HTTP calls', async () => {
    updateSettings({ retryAttempts: 5 });
    for (let index = 0; index < 4; index += 1) addModel(`model-backup-${index}`, 90 - index);
    transport.mockImplementation(async () => unavailable());
    await expect(withAIRequestBudget(() => generate('Question', {}))).rejects.toBeInstanceOf(AIRequestBudgetError);
    expect(transport).toHaveBeenCalledTimes(24);
  });

  it('combines a two-minute reply deadline with a 45-second attempt timeout', async () => {
    const deadlines: Array<{ ms: number; controller: AbortController }> = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      deadlines.push({ ms, controller });
      return controller.signal;
    });
    await withAIRequestBudget(async () => {
      const signal = claimAIRequest();
      expect(deadlines.map((deadline) => deadline.ms)).toEqual([120_000, 45_000]);
      deadlines[0].controller.abort(new DOMException('deadline reached', 'TimeoutError'));
      expect(signal.aborted).toBe(true);
      expect(() => claimAIRequest()).toThrow(AIRequestBudgetError);
    });
  });

  it('passes caller cancellation through to the SDK transport', async () => {
    updateSettings({ retryAttempts: 2 });
    const controller = new AbortController();
    transport.mockImplementation(async (_input, init) => {
      controller.abort(new Error('Caller cancelled'));
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    await expect(generate('Question', { abortSignal: controller.signal })).rejects.toThrow('Caller cancelled');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(listModels()[0].consecutiveFailures).toBe(0);
  });

  it('does not admit or send an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Already cancelled'));
    await expect(generate('Question', { abortSignal: controller.signal })).rejects.toThrow('Already cancelled');
    expect(transport).not.toHaveBeenCalled();
    expect(listModels()[0].consecutiveFailures).toBe(0);
  });

  it('cancels a backoff immediately without spending another paid attempt', async () => {
    vi.useFakeTimers();
    updateSettings({ retryAttempts: 2, retryDelayMs: 60_000 });
    const controller = new AbortController();
    transport.mockImplementation(async () => unavailable());
    const attempt = generate('Question', { abortSignal: controller.signal });
    const assertion = expect(attempt).rejects.toThrow('Cancelled during backoff');
    await vi.advanceTimersByTimeAsync(100);
    expect(transport).toHaveBeenCalledTimes(1);
    controller.abort(new Error('Cancelled during backoff'));
    await assertion;
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('shares the reply deadline with retry backoff', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    await withAIRequestBudget(async () => {
      const waiting = retryDelay(60_000, 0);
      const assertion = expect(waiting).rejects.toThrow('Reply deadline');
      controller.abort(new Error('Reply deadline'));
      await assertion;
      await expect(retryDelay(60_000, 0)).rejects.toThrow('Reply deadline');
    });
  });
});

describe('request budget refusals name their cause', () => {
  it('separates running out of time from running out of attempts', async () => {
    const { withAIRequestBudget, claimAIRequest, AIRequestBudgetError } =
      await import('../../src/server/ai/requestBudget');
    const controller = new AbortController();
    const original = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => (ms === 120_000 ? controller.signal : original(ms)));
    try {
      await withAIRequestBudget(async () => {
        controller.abort(new Error('deadline'));
        // Both refusals shared one message, so a reply killed by the deadline
        // was logged as having exhausted its attempts.
        expect(() => claimAIRequest()).toThrow(AIRequestBudgetError);
        expect(() => claimAIRequest()).toThrow(/ran out of time/);
      });
    } finally {
      vi.mocked(AbortSignal.timeout).mockImplementation(original);
    }
  });

  it('does not spend an attempt on a refused claim', async () => {
    const { withAIRequestBudget, claimAIRequest } = await import('../../src/server/ai/requestBudget');
    await withAIRequestBudget(async () => {
      for (let attempt = 0; attempt < 24; attempt += 1) expect(() => claimAIRequest()).not.toThrow();
      // Every later refusal must report the same state rather than counting down
      // past zero on an error path.
      expect(() => claimAIRequest()).toThrow(/exhausted/);
      expect(() => claimAIRequest()).toThrow(/exhausted/);
    });
  });
});
