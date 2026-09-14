import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from 'openai';

// A fake OpenRouter: each call takes the next queued reply. Parameters are
// copied as they arrive, since the runner appends to the same message list
// when it asks again.
const client = vi.hoisted(() => ({
  replies: [] as Array<(params: Record<string, unknown>) => unknown>,
  calls: [] as Array<Record<string, any>>,
}));

vi.mock('../../src/server/ai/openrouter', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/server/ai/openrouter')>(),
  openrouter: () => ({
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          client.calls.push(structuredClone(params));
          const next = client.replies.shift();
          if (!next) throw new Error('no reply queued');
          return next(params);
        },
      },
    },
  }),
}));

const catalog = vi.hoisted(() => ({ images: new Map<string, boolean>() }));
vi.mock('../../src/server/ai/catalog', () => ({
  capabilitiesOf: async (model: string) =>
    catalog.images.has(model) ? { images: catalog.images.get(model)!, tools: true, jsonMode: true } : null,
}));

import { db } from '../../src/server/db/client';
import { aiTasks, aiUsage, settings, taskModels } from '../../src/server/db/schema';
import { addTaskModel, listTaskModels } from '../../src/server/db/repositories/taskModelsRepo';
import { setReasoningEffort } from '../../src/server/db/repositories/aiTasksRepo';
import { forgetMandatoryReasoning } from '../../src/server/ai/reasoning';
import { updateSettings } from '../../src/server/db/repositories/settingsRepo';
import { structured, UnreadableAnswerError } from '../../src/server/ai/structured';
import { BillingError, OverloadedError } from '../../src/server/ai/errors';
import type { JsonSchema } from '../../src/server/ai/jsonSchema';

const schema: JsonSchema = {
  type: 'object',
  properties: { answer: { type: 'string' }, count: { type: 'integer' } },
  required: ['answer', 'count'],
  additionalProperties: false,
};
const request = { system: 'THE SAVED PROMPT', user: 'The material', schema };
const good = '{"answer":"ok","count":1}';

const reply = (content: string | null, finish = 'stop') => () => ({
  choices: [{ message: { content }, finish_reason: finish }],
  usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.00002, prompt_tokens_details: { cached_tokens: 64 } },
  provider: 'DeepSeek',
});
const fail = (status: number, body: Record<string, unknown>) => () => {
  throw APIError.generate(status, { error: { code: status, ...body } }, undefined, new Headers());
};

beforeEach(() => {
  client.replies = [];
  client.calls = [];
  catalog.images = new Map();
  db.delete(taskModels).run();
  db.delete(aiTasks).run();
  db.delete(aiUsage).run();
  db.delete(settings).run();
  forgetMandatoryReasoning();
  updateSettings({ retryAttempts: 0, retryDelayMs: 0, modelFailureThreshold: 20 });
  addTaskModel('factExtraction', 'a/first', 'deepseek');
  addTaskModel('factExtraction', 'b/second', '');
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

describe('what a structured call sends', () => {
  it("sends the saved prompt untouched, the answer's shape separately, in JSON mode, pinned to its host", async () => {
    client.replies.push(reply(good));
    expect(await structured('factExtraction', request)).toEqual({ answer: 'ok', count: 1 });

    const [call] = client.calls;
    expect(call.model).toBe('a/first');
    expect(call.messages[0]).toEqual({ role: 'system', content: 'THE SAVED PROMPT' });
    expect(call.messages[1].role).toBe('system');
    expect(call.messages[1].content).toContain(JSON.stringify(schema));
    expect(call.messages[2]).toEqual({ role: 'user', content: 'The material' });
    expect(call.response_format).toEqual({ type: 'json_object' });
    expect(call.reasoning).toEqual({ effort: 'none' });
    expect(call.provider).toEqual({ order: ['deepseek'], allow_fallbacks: false, require_parameters: true });
  });

  it('records what the call was billed', async () => {
    client.replies.push(reply(good));
    await structured('factExtraction', request);
    expect(db.select().from(aiUsage).all()).toEqual([expect.objectContaining({
      task: 'factExtraction', model: 'a/first', provider: 'DeepSeek', cost: 0.00002, cachedTokens: 64, outcome: 'ok',
    })]);
  });
});

describe('reasoning', () => {
  // A structured answer used to be sent with reasoning hardcoded off, which left
  // an operator no way to give a model that needs a moment's thought one, and no
  // way onto an endpoint that will not answer without it.
  it("follows the task's own setting, like the reply does", async () => {
    setReasoningEffort('factExtraction', 'medium');
    client.replies.push(reply(good));
    await structured('factExtraction', request);
    expect(client.calls[0].reasoning).toEqual({ effort: 'medium' });
  });

  it('asks again without the field when the endpoint says reasoning cannot be switched off', async () => {
    client.replies.push(
      fail(400, { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' }),
      reply(good),
    );
    expect(await structured('factExtraction', request)).toEqual({ answer: 'ok', count: 1 });

    // The same model, twice: the model was never the problem.
    expect(client.calls.map((call) => call.model)).toEqual(['a/first', 'a/first']);
    expect(client.calls[0].reasoning).toEqual({ effort: 'none' });
    expect(client.calls[1].reasoning).toBeUndefined();
  });

  it('remembers that endpoint, so the next call does not spend a request finding out again', async () => {
    client.replies.push(
      fail(400, { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' }),
      reply(good),
      reply(good),
    );
    await structured('factExtraction', request);
    await structured('factExtraction', request);
    expect(client.calls).toHaveLength(3);
    expect(client.calls[2].reasoning).toBeUndefined();
  });

  // Raising the effort is a different decision from the one that was refused.
  it('sends the field again once the effort is no longer none', async () => {
    client.replies.push(
      fail(400, { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' }),
      reply(good),
      reply(good),
    );
    await structured('factExtraction', request);
    setReasoningEffort('factExtraction', 'high');
    await structured('factExtraction', request);
    expect(client.calls[2].reasoning).toEqual({ effort: 'high' });
  });

  it('moves to the next model when it still will not answer', async () => {
    const refusal = { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' };
    client.replies.push(fail(400, refusal), fail(400, refusal), reply(good));
    expect(await structured('factExtraction', request)).toEqual({ answer: 'ok', count: 1 });
    expect(client.calls.map((call) => call.model)).toEqual(['a/first', 'a/first', 'b/second']);
  });
});

describe('answers in the wrong shape', () => {
  it('asks the same model once more, quoting what was wrong', async () => {
    client.replies.push(reply('{"answer":"ok"}'), reply(good));
    expect(await structured('factExtraction', request)).toEqual({ answer: 'ok', count: 1 });
    expect(client.calls.map((call) => call.model)).toEqual(['a/first', 'a/first']);
    const retry = client.calls[1].messages;
    expect(retry.at(-2)).toEqual({ role: 'assistant', content: '{"answer":"ok"}' });
    expect(retry.at(-1).content).toContain('the answer is missing "count"');
  });

  it('asks again after an empty answer', async () => {
    client.replies.push(reply(''), reply(good));
    expect(await structured('factExtraction', request)).toEqual({ answer: 'ok', count: 1 });
    expect(client.calls[1].messages.at(-1).content).toContain('the answer was empty');
  });

  it('gives up on a model that gets the shape wrong twice, as an unreadable answer', async () => {
    client.replies.push(reply('not json'), reply('{"answer":1,"count":1}'));
    const error = await structured('factExtraction', request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnreadableAnswerError);
    expect(error).toMatchObject({ truncated: false });
    expect(client.calls).toHaveLength(2);
  });

  it('does not ask again after a truncated answer, since the same window would run out the same way', async () => {
    client.replies.push(reply('{"answer":"o', 'length'));
    const error = await structured('factExtraction', request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'UnreadableAnswerError', truncated: true });
    expect(client.calls).toHaveLength(1);
  });
});

describe('when a model fails', () => {
  it('moves to the next model on a transient failure and counts it against the first', async () => {
    client.replies.push(fail(503, { message: 'overloaded' }), reply(good));
    expect(await structured('factExtraction', request)).toEqual({ answer: 'ok', count: 1 });
    expect(client.calls.map((call) => call.model)).toEqual(['a/first', 'b/second']);
    expect(listTaskModels('factExtraction')[0]).toMatchObject({ model: 'a/first', consecutiveFailures: 1 });
    expect(client.calls[1].provider).toEqual({ require_parameters: true });
  });

  it('stops at once when the key is out of credit, trying no other model', async () => {
    client.replies.push(fail(402, { message: 'Insufficient credits' }));
    await expect(structured('factExtraction', request)).rejects.toBeInstanceOf(BillingError);
    expect(client.calls).toHaveLength(1);
  });

  it('retires a model OpenRouter says does not exist, on every list, and carries on', async () => {
    addTaskModel('reply', 'a/first', 'deepseek');
    client.replies.push(fail(400, { message: 'a/first is not a valid model ID' }), reply(good));
    expect(await structured('factExtraction', request)).toEqual({ answer: 'ok', count: 1 });
    expect(listTaskModels('factExtraction').find((entry) => entry.model === 'a/first')?.retired).toBe(true);
    expect(listTaskModels('reply')[0].retired).toBe(true);
  });

  it('fails outright when an upstream host rejects the request itself', async () => {
    client.replies.push(fail(400, { message: 'Provider returned error', metadata: { provider_name: 'DeepSeek', raw: 'bad' } }));
    await expect(structured('factExtraction', request)).rejects.toMatchObject({ status: 400 });
    expect(client.calls).toHaveLength(1);
  });

  it('reports every model it tried once none of them answered', async () => {
    client.replies.push(fail(503, { message: 'down' }), fail(502, { message: 'bad gateway' }));
    const error = await structured('factExtraction', request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OverloadedError);
    expect(error).toMatchObject({ triedModels: ['a/first', 'b/second'] });
  });

  it('says so plainly when the list is empty', async () => {
    db.delete(taskModels).run();
    await expect(structured('factExtraction', request)).rejects.toThrow('No factExtraction models are configured');
  });
});

describe('pictures', () => {
  const images = [{ messageId: '1', mimeType: 'image/png', data: 'AAAA' }];

  it('go to a model that can see them first, and to one that cannot only after, marked as not shown', async () => {
    catalog.images = new Map([['a/first', false], ['b/second', true]]);
    client.replies.push(fail(503, { message: 'down' }), reply(good));
    await structured('factExtraction', { ...request, images });

    expect(client.calls.map((call) => call.model)).toEqual(['b/second', 'a/first']);
    expect(client.calls[0].messages[2].content).toEqual([
      { type: 'text', text: 'The material' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(client.calls[1].messages[2].content).toContain('could not be sent to you');
  });

  it('are sent to a model whose capabilities are unknown rather than stripped', async () => {
    client.replies.push(reply(good));
    await structured('factExtraction', { ...request, images });
    expect(Array.isArray(client.calls[0].messages[2].content)).toBe(true);
  });
});
