import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ChromaNotFoundError, type Collection } from 'chromadb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/server/env', () => ({ env: { chromaHost: '127.0.0.1', chromaPort: 8000 } }));
vi.mock('../../src/server/ai/embeddings', () => ({
  geminiEmbeddingFunction: { generate: async () => [[1, 0, 0]] },
}));

type ResponseMode = 'healthy' | 'hang-headers' | 'hang-body' | 'missing';
let server: Server | undefined;
let mode: ResponseMode;
let port: number;
let received: number;
let closedIncomplete: number;

beforeEach(async () => {
  vi.resetModules();
  mode = 'healthy';
  received = 0;
  closedIncomplete = 0;
  server = createServer((_request, response) => {
    received++;
    response.on('close', () => {
      if (!response.writableEnded) closedIncomplete++;
    });
    if (mode === 'hang-headers') return;
    if (mode === 'hang-body') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"nanosecond heartbeat":');
      return;
    }
    response.writeHead(mode === 'missing' ? 404 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(mode === 'missing' ? { error: 'not found' } : { 'nanosecond heartbeat': 123 }));
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP test server port');
  port = address.port;
});

afterEach(async () => {
  vi.doUnmock('chromadb');
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  }
});

async function client(timeoutMs = 150) {
  const { createBoundedChromaClient } = await import('../../src/server/db/chroma');
  return createBoundedChromaClient({ host: '127.0.0.1', port, ssl: false }, timeoutMs);
}

describe('installed Chroma SDK bounded transport contract', () => {
  it('uses the configured SDK transport and preserves its HTTP error classes', async () => {
    const chroma = await client();
    await expect(chroma.heartbeat()).resolves.toBe(123);
    mode = 'missing';
    await expect(chroma.heartbeat()).rejects.toBeInstanceOf(ChromaNotFoundError);
    expect(received).toBe(2);
  });

  it('aborts hung headers and recovers on the same client with a fresh timeout', async () => {
    const chroma = await client();
    mode = 'hang-headers';
    await expect(chroma.heartbeat()).rejects.toHaveProperty('name', 'TimeoutError');
    await vi.waitFor(() => expect(closedIncomplete).toBe(1));
    mode = 'healthy';
    await expect(chroma.heartbeat()).resolves.toBe(123);
    await delay(175);
    await expect(chroma.heartbeat()).resolves.toBe(123);
    expect(received).toBe(3);
  });

  it('also aborts a response whose headers arrive but whose JSON body hangs', async () => {
    const chroma = await client();
    mode = 'hang-body';
    await expect(chroma.heartbeat()).rejects.toThrow();
    await vi.waitFor(() => expect(closedIncomplete).toBe(1));
    mode = 'healthy';
    await expect(chroma.heartbeat()).resolves.toBe(123);
  });

  it('honors the outer reply deadline without spending a Gemini attempt', async () => {
    const chroma = await client(2_000);
    const { withAIRequestBudget, claimAIRequest } = await import('../../src/server/ai/requestBudget');
    const controller = new AbortController();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => ms === 120_000 ? controller.signal : originalTimeout(ms));
    const reason = new Error('reply expired');
    mode = 'hang-headers';
    await withAIRequestBudget(async () => {
      const pending = chroma.heartbeat();
      const rejection = expect(pending).rejects.toBe(reason);
      await vi.waitFor(() => expect(received).toBe(1));
      controller.abort(reason);
      await rejection;
    });
    await vi.waitFor(() => expect(closedIncomplete).toBe(1));
    mode = 'healthy';
    vi.mocked(AbortSignal.timeout).mockImplementation(originalTimeout);
    await withAIRequestBudget(async () => {
      await expect(chroma.heartbeat()).resolves.toBe(123);
      for (let attempt = 0; attempt < 24; attempt++) expect(() => claimAIRequest()).not.toThrow();
      expect(() => claimAIRequest()).toThrow('exhausted');
    });
  });

  it('preserves a caller-provided fetch signal', async () => {
    const { createBoundedChromaClient } = await import('../../src/server/db/chroma');
    const controller = new AbortController();
    const chroma = createBoundedChromaClient({
      host: '127.0.0.1', port, ssl: false, fetchOptions: { signal: controller.signal },
    }, 2_000);
    mode = 'hang-headers';
    const reason = new Error('caller cancelled');
    const rejection = expect(chroma.heartbeat()).rejects.toBe(reason);
    await vi.waitFor(() => expect(received).toBe(1));
    controller.abort(reason);
    await rejection;
    await vi.waitFor(() => expect(closedIncomplete).toBe(1));
  });

  it('fails descriptively at startup when the SDK transport contract disappears', async () => {
    vi.doMock('chromadb', () => ({ ChromaClient: class {} }));
    await expect(import('../../src/server/db/chroma')).rejects.toThrow('Unsupported Chroma SDK HTTP client');
  });
});

describe('facts collection initialization', () => {
  it('coalesces simultaneous initialization and keeps the successful handle', async () => {
    const { chroma, getFactsCollection } = await import('../../src/server/db/chroma');
    const collection = { name: 'facts' } as Collection;
    let resolve!: (value: Collection) => void;
    const initialize = vi.spyOn(chroma, 'getOrCreateCollection').mockImplementation(() => new Promise((done) => { resolve = done; }));
    const first = getFactsCollection();
    const second = getFactsCollection();
    expect(initialize).toHaveBeenCalledTimes(1);
    resolve(collection);
    await expect(first).resolves.toBe(collection);
    await expect(second).resolves.toBe(collection);
    await expect(getFactsCollection()).resolves.toBe(collection);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('clears a failed initialization so a later request can retry', async () => {
    const { chroma, getFactsCollection } = await import('../../src/server/db/chroma');
    const collection = { name: 'facts' } as Collection;
    const initialize = vi.spyOn(chroma, 'getOrCreateCollection')
      .mockRejectedValueOnce(new Error('temporary connection failure'))
      .mockResolvedValue(collection);
    await expect(getFactsCollection()).rejects.toThrow('temporary connection failure');
    await expect(getFactsCollection()).resolves.toBe(collection);
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('lets a deadline expire while waiting without cancelling another caller initialization', async () => {
    const { chroma, getFactsCollection } = await import('../../src/server/db/chroma');
    const { withAIRequestBudget } = await import('../../src/server/ai/requestBudget');
    const collection = { name: 'facts' } as Collection;
    let resolve!: (value: Collection) => void;
    const initialize = vi.spyOn(chroma, 'getOrCreateCollection').mockImplementation(() => new Promise((done) => { resolve = done; }));
    const owner = getFactsCollection();
    const controller = new AbortController();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => ms === 120_000 ? controller.signal : originalTimeout(ms));
    const reason = new Error('waiting reply expired');
    const waiting = withAIRequestBudget(() => getFactsCollection());
    const rejection = expect(waiting).rejects.toBe(reason);
    controller.abort(reason);
    await rejection;
    resolve(collection);
    await expect(owner).resolves.toBe(collection);
    await expect(getFactsCollection()).resolves.toBe(collection);
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});
