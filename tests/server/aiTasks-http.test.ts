import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// What the catalog knows, per test. Plain functions rather than vi.fn, so the
// suite's restoreMocks setting cannot strip their behaviour between tests.
const catalog = vi.hoisted(() => ({
  reachable: true,
  known: new Map<string, { images: boolean; tools: boolean; jsonMode: boolean }>(),
}));

vi.mock('../../src/server/ai/catalog', () => {
  const offline = () => {
    if (!catalog.reachable) throw new Error('fetch failed');
  };
  const host = { tag: 'deepseek', providerName: 'DeepSeek', supportedParameters: [], pricing: {}, status: 0 };
  return {
    catalogModels: async () => {
      offline();
      return [];
    },
    catalogModel: async (id: string) => {
      offline();
      return catalog.known.has(id) ? { id, name: id, kind: 'chat' } : null;
    },
    catalogEndpoints: async () => {
      offline();
      return [host];
    },
    capabilitiesOf: async (id: string) => {
      offline();
      return catalog.known.get(id) ?? null;
    },
    cheapestEndpoint: async () => {
      offline();
      return 'deepseek';
    },
    endpointFor: (list: Array<{ tag: string }>, upstream: string) =>
      list.find((entry) => entry.tag === upstream || entry.tag.split('/')[0] === upstream),
  };
});

import { db } from '../../src/server/db/client';
import { aiTasks, taskModels } from '../../src/server/db/schema';
import { addTaskModel, listTaskModels, retireModelEverywhere } from '../../src/server/db/repositories/taskModelsRepo';
import { aiTasksRouter } from '../../src/server/api/routes/aiTasks';
import { BUILT_IN_AI_TASKS, DEFAULT_CHAT_MODEL } from '../../src/shared/aiTasks';
import type { AiTasksOverview } from '../../src/shared/types';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/ai-tasks', aiTasksRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  catalog.reachable = true;
  catalog.known = new Map([
    [DEFAULT_CHAT_MODEL, { images: true, tools: true, jsonMode: true }],
    ['vendor/json-only', { images: false, tools: false, jsonMode: true }],
  ]);
  db.delete(taskModels).run();
  db.delete(aiTasks).run();
  for (const task of BUILT_IN_AI_TASKS) addTaskModel(task.id, DEFAULT_CHAT_MODEL, 'deepseek');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}/ai-tasks${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as { success: boolean; data: AiTasksOverview; error: string } };
}

const taskIn = (overview: AiTasksOverview, id: string) => overview.tasks.find((task) => task.id === id)!;

describe('the AI tasks overview', () => {
  it('lists every built-in task with its models, what they can do, and nothing to warn about', async () => {
    const { json } = await call('GET', '/');
    expect(json.data.catalogAvailable).toBe(true);
    expect(json.data.tasks.map((task) => task.id)).toEqual(BUILT_IN_AI_TASKS.map((task) => task.id));
    for (const task of json.data.tasks) {
      expect(task.models).toEqual([expect.objectContaining({
        model: DEFAULT_CHAT_MODEL, upstream: 'deepseek', capabilities: { images: true, tools: true, jsonMode: true },
      })]);
      expect(task.warnings).toEqual([]);
    }
    expect(taskIn(json.data, 'reply').reasoningEffort).toBe('none');
  });

  it('warns about an empty list, an unpinned row, and a model that cannot see pictures', async () => {
    db.delete(taskModels).run();
    addTaskModel('factExtraction', 'vendor/json-only', '');
    const { json } = await call('GET', '/');
    expect(taskIn(json.data, 'reply').warnings[0]).toContain('cannot run at all');
    const warnings = taskIn(json.data, 'factExtraction').warnings.join(' ');
    expect(warnings).toContain('cannot see pictures');
    expect(warnings).toContain('not pinned to a host');
  });
});

describe('adding models', () => {
  it('pins a new model to the cheapest host that can do the job', async () => {
    const { status } = await call('POST', '/topicExtraction/models', { model: 'vendor/json-only' });
    expect(status).toBe(200);
    expect(listTaskModels('topicExtraction').map((entry) => [entry.model, entry.upstream]))
      .toEqual([[DEFAULT_CHAT_MODEL, 'deepseek'], ['vendor/json-only', 'deepseek']]);
  });

  it('refuses a model OpenRouter does not know', async () => {
    const { status, json } = await call('POST', '/reply/models', { model: 'nobody/nothing' });
    expect(status).toBe(400);
    expect(json.error).toContain('is not a chat model OpenRouter knows');
  });

  it('refuses a model that cannot call tools for the reply', async () => {
    const { status, json } = await call('POST', '/reply/models', { model: 'vendor/json-only' });
    expect(status).toBe(400);
    expect(json.error).toContain('cannot call tools');
  });

  it('refuses a host the model is not served by', async () => {
    const { status, json } = await call('POST', '/reply/models', { model: DEFAULT_CHAT_MODEL, upstream: 'fireworks' });
    expect(status).toBe(400);
    expect(json.error).toContain('is not served by fireworks');
  });

  it('refuses something that is not an OpenRouter model id', async () => {
    expect((await call('POST', '/reply/models', { model: 'gemini-3.1-flash-lite' })).status).toBe(400);
  });

  it('takes a model unchecked while the catalog is unreachable, and says the catalog is down', async () => {
    catalog.reachable = false;
    expect((await call('POST', '/reply/models', { model: 'vendor/anything' })).status).toBe(200);
    expect(listTaskModels('reply').at(-1)).toMatchObject({ model: 'vendor/anything', upstream: '' });
    const { json } = await call('GET', '/');
    expect(json.data.catalogAvailable).toBe(false);
  });

  it('answers 404 for a task that does not exist', async () => {
    expect((await call('POST', '/nonsense/models', { model: DEFAULT_CHAT_MODEL })).status).toBe(404);
  });
});

describe('editing a list', () => {
  it('reorders, re-pins and removes, with the model id in the query where a path cannot carry it', async () => {
    await call('POST', '/topicExtraction/models', { model: 'vendor/json-only' });
    await call('PUT', '/topicExtraction/models/order', { order: ['vendor/json-only', DEFAULT_CHAT_MODEL] });
    expect(listTaskModels('topicExtraction').map((entry) => entry.model)).toEqual(['vendor/json-only', DEFAULT_CHAT_MODEL]);

    expect((await call('PATCH', '/topicExtraction/models', { model: 'vendor/json-only', upstream: '' })).status).toBe(200);
    expect(listTaskModels('topicExtraction')[0].upstream).toBe('');

    const { status } = await call('DELETE', `/topicExtraction/models?model=${encodeURIComponent('vendor/json-only')}`);
    expect(status).toBe(200);
    expect(listTaskModels('topicExtraction').map((entry) => entry.model)).toEqual([DEFAULT_CHAT_MODEL]);
    expect((await call('DELETE', '/topicExtraction/models?model=vendor/json-only')).status).toBe(404);
  });

  it('lets Reset errors bring back a retired model on that list only', async () => {
    retireModelEverywhere(DEFAULT_CHAT_MODEL, '400 not a valid model ID');
    const { json } = await call('POST', '/reply/revive');
    expect(taskIn(json.data, 'reply').models[0].retired).toBe(false);
    expect(taskIn(json.data, 'topicExtraction').models[0].retired).toBe(true);
  });
});

describe('reasoning effort', () => {
  it('can be raised for the reply', async () => {
    const { status, json } = await call('PATCH', '/reply', { reasoningEffort: 'low' });
    expect(status).toBe(200);
    expect(taskIn(json.data, 'reply').reasoningEffort).toBe('low');
  });

  // Some models comprehend the question far better with a little reasoning, and
  // some endpoints refuse to answer without any, so a task answering in JSON
  // mode is no longer a reason to withhold the setting.
  it('can be raised for a task that answers in JSON mode', async () => {
    const { status, json } = await call('PATCH', '/topicExtraction', { reasoningEffort: 'low' });
    expect(status).toBe(200);
    expect(taskIn(json.data, 'topicExtraction').reasoningEffort).toBe('low');
  });

  it('cannot be set to something made up', async () => {
    expect((await call('PATCH', '/reply', { reasoningEffort: 'extreme' })).status).toBe(400);
  });
});
