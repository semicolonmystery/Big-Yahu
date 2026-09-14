import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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
import { promptOverrides } from '../../src/server/db/schema';
import { promptsRouter } from '../../src/server/api/routes/prompts';
import { PROMPTS } from '../../src/server/ai/prompts/registry';
import {
  buildReplyInstruction,
  buildTopicExtractionInstruction,
} from '../../src/server/ai/prompts/build';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/prompts', promptsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.$client.close();
});

beforeEach(() => {
  db.delete(promptOverrides).run();
});

const send = (method: string, path: string, body?: unknown) => fetch(`${baseUrl}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const VALID_REPLY = 'answer people, briefly, and link what you quote';

describe('editing the prompts over HTTP', () => {
  it('lists all three with the shipped text and no override yet', async () => {
    const payload = await (await send('GET', '/prompts')).json();
    expect(payload.success).toBe(true);
    expect(payload.data.map((entry: { id: string }) => entry.id))
      .toEqual(['factExtraction', 'topicExtraction', 'reply']);

    const reply = payload.data.find((entry: { id: string }) => entry.id === 'reply');
    expect(reply.override).toBeNull();
    expect(reply.shipped).toBe(PROMPTS.reply.fallback);
    expect(reply.legacyFormat).toBe(false);
  });

  it('saves an override and uses it on the very next call', async () => {
    const response = await send('PUT', '/prompts/reply', { body: VALID_REPLY });
    expect(response.status).toBe(200);

    // No restart, no cache to bust — and exactly what was saved, nothing more.
    expect(buildReplyInstruction()).toBe(VALID_REPLY);
  });

  it('refuses an empty prompt, and changes nothing', async () => {
    const response = await send('PUT', '/prompts/reply', { body: '   ' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('cannot be empty');
    expect(buildReplyInstruction()).toBe(PROMPTS.reply.fallback);
  });

  it('says when a saved prompt was written for the old transcript format', async () => {
    await send('PUT', '/prompts/factExtraction', { body: 'Lines are tagged [id=...]. Extract facts.' });
    const payload = await (await send('GET', '/prompts')).json();
    const extraction = payload.data.find((entry: { id: string }) => entry.id === 'factExtraction');
    expect(extraction.legacyFormat).toBe(true);
  });

  it('resets by deleting the override rather than copying the default in', async () => {
    await send('PUT', '/prompts/topicExtraction', { body: 'just the topic please' });
    expect(buildTopicExtractionInstruction()).toBe('just the topic please');

    const reset = await send('DELETE', '/prompts/topicExtraction');
    expect((await reset.json()).data.reset).toBe(true);
    expect(db.select().from(promptOverrides).all()).toHaveLength(0);
    expect(buildTopicExtractionInstruction()).toBe(PROMPTS.topicExtraction.fallback);
  });

  it('reports an unknown prompt rather than creating one', async () => {
    expect((await send('PUT', '/prompts/nonsense', { body: 'x' })).status).toBe(404);
    expect((await send('DELETE', '/prompts/nonsense')).status).toBe(404);
  });

  it('rejects a body that is not a string', async () => {
    expect((await send('PUT', '/prompts/reply', { body: 42 })).status).toBe(400);
  });

  it('accepts an uploaded text file and validates it the same way', async () => {
    const upload = async (text: string) => {
      const form = new FormData();
      form.append('prompt', new Blob([text], { type: 'text/plain' }), 'reply.txt');
      return fetch(`${baseUrl}/prompts/reply/upload`, { method: 'POST', body: form });
    };

    expect((await upload('   ')).status).toBe(400);
    expect((await upload(VALID_REPLY)).status).toBe(200);
    expect(buildReplyInstruction()).toBe(VALID_REPLY);
  });

  it('will not take a file that is not text', async () => {
    const form = new FormData();
    form.append('prompt', new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01])]), 'reply.docx');
    const response = await fetch(`${baseUrl}/prompts/reply/upload`, { method: 'POST', body: form });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('not a text file');
  });

  it('appends nothing of its own to a saved prompt, and substitutes nothing into it', async () => {
    await send('PUT', '/prompts/reply', { body: VALID_REPLY });
    expect(buildReplyInstruction()).toBe(VALID_REPLY);
  });
});
