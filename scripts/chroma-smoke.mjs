import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ChromaClient } from 'chromadb';

// Run against an explicitly selected disposable Chroma instance. No application
// modules, Discord credentials, Gemini calls, or existing collections are used.
const host = process.env.CHROMA_HOST || '127.0.0.1';
const port = Number(process.env.CHROMA_PORT);
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Set CHROMA_PORT to the disposable Chroma instance port');
const origin = new URL(`http://${host}:${port}`);
const name = `big-yahu-smoke-${randomUUID()}`;

const embeddingFunction = {
  name: 'big-yahu-smoke',
  defaultSpace: () => 'cosine',
  supportedSpaces: () => ['cosine'],
  getConfig: () => ({ dimensions: 3 }),
  generate: async (texts) => texts.map((text) => {
    if (text.includes('apple')) return [1, 0, 0];
    if (text.includes('banana')) return [0, 1, 0];
    if (text.includes('router')) return [0, 0, 1];
    throw new Error(`Smoke fixture has no deterministic embedding: ${text}`);
  }),
};

async function waitForChroma() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/api/v2/heartbeat', origin), { signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* A new container can take a moment to listen. */ }
    await delay(250);
  }
  throw new Error('Chroma did not become ready within 90 seconds');
}

await waitForChroma();
const clientOptions = { host, port, ssl: false, fetchOptions: { signal: AbortSignal.timeout(30_000) } };
const client = new ChromaClient(clientOptions);
let created = false;
try {
  const collection = await client.createCollection({ name, embeddingFunction });
  created = true;
  const metadata = {
    guildId: 'smoke-guild', channelId: 'smoke-channel', source: 'auto', createdAt: 1,
    messageIds: ['message-1', 'message-2'], authorIds: ['author-1'],
  };
  await collection.add({
    ids: ['fact-a', 'fact-b', 'foreign-fact'],
    documents: ['apple fruit', 'router network', 'apple elsewhere'],
    metadatas: [metadata, { ...metadata, messageIds: ['message-b'] }, { ...metadata, guildId: 'other-guild' }],
  });
  assert.equal(await collection.count(), 3);
  const fetched = await collection.get({ ids: ['fact-a'], include: ['documents', 'metadatas', 'embeddings'] });
  assert.deepEqual(fetched.ids, ['fact-a']);
  assert.equal(fetched.documents[0], 'apple fruit');
  assert.deepEqual(fetched.metadatas[0].messageIds, ['message-1', 'message-2']);
  assert.deepEqual(fetched.metadatas[0].authorIds, ['author-1']);
  assert.deepEqual(fetched.embeddings[0], [1, 0, 0]);

  const query = await collection.query({
    queryTexts: ['apple fruit'], nResults: 2, where: { guildId: 'smoke-guild' },
    include: ['documents', 'metadatas', 'distances'],
  });
  assert.equal(query.ids[0][0], 'fact-a');
  assert(!query.ids[0].includes('foreign-fact'), 'Guild metadata filtering must exclude the foreign fixture');
  assert(Math.abs(query.distances[0][0]) < 0.00001);

  // Superseding a fact updates its content/sources without breaking its ID.
  await collection.update({
    ids: ['fact-a'], documents: ['banana fruit'],
    metadatas: [{ ...metadata, messageIds: ['message-1', 'message-2', 'message-3'], authorIds: ['author-1', 'author-2'] }],
  });
  const reopened = await new ChromaClient(clientOptions).getCollection({ name, embeddingFunction });
  assert.equal(await reopened.count(), 3);
  const updated = await reopened.get({ ids: ['fact-a'], include: ['documents', 'metadatas'] });
  assert.deepEqual(updated.ids, ['fact-a']);
  assert.equal(updated.documents[0], 'banana fruit');
  assert.deepEqual(updated.metadatas[0].messageIds, ['message-1', 'message-2', 'message-3']);
  assert.deepEqual(updated.metadatas[0].authorIds, ['author-1', 'author-2']);
  const afterUpdate = await reopened.query({ queryTexts: ['banana fruit'], nResults: 1, where: { guildId: 'smoke-guild' } });
  assert.equal(afterUpdate.ids[0][0], 'fact-a');

  await reopened.delete({ ids: ['fact-b'] });
  assert.equal(await reopened.count(), 2);
  assert.deepEqual((await reopened.get({ ids: ['fact-b'] })).ids, []);
  console.log('Chroma smoke passed: create/add/get, metadata arrays, filtered vector query, stable-ID update, new client, record delete.');
} finally {
  if (created) {
    // This exact random collection was created above; never reset the server.
    await new ChromaClient({ host, port, ssl: false, fetchOptions: { signal: AbortSignal.timeout(5_000) } })
      .deleteCollection({ name });
    console.log(`Cleaned up smoke collection ${name}.`);
  }
}
