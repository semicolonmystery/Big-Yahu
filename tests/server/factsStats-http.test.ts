import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Fact } from '../../src/shared/types';

const state = vi.hoisted(() => ({
  facts: [] as Fact[],
  search: vi.fn(), page: vi.fn(), all: vi.fn(), count: vi.fn(), remove: vi.fn(),
  names: { '222': 'Bob Gateway', '999': 'Big Yahu' } as Record<string, string>,
}));
vi.mock('../../src/server/db/repositories/factsRepo', async (importOriginal) => ({
  // peopleIn is pure and the point of this route, so it is the real one.
  peopleIn: (await importOriginal<typeof import('../../src/server/db/repositories/factsRepo')>()).peopleIn,
  searchFacts: state.search, listFactsPage: state.page, listAllFacts: state.all, countFacts: state.count, deleteFact: state.remove,
  // The store itself is mocked here; the SQLite mirror these routes read is real
  // and seeded below, so there is never anything for a rebuild to reconcile.
  ensureFactIndex: async () => {},
}));
vi.mock('../../src/server/bot/identity', () => ({ knownDisplayNames: () => state.names }));
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
import { cachedMessages, factIndex, replyLog, sessions, settings } from '../../src/server/db/schema';
import { createSession } from '../../src/server/db/repositories/authRepo';
import { cacheMessages } from '../../src/server/db/repositories/cachedMessagesRepo';
import { updateSettings } from '../../src/server/db/repositories/settingsRepo';
import { logReply } from '../../src/server/db/repositories/replyLogRepo';
import { indexFacts } from '../../src/server/db/repositories/factIndexRepo';
import { requireAuth } from '../../src/server/api/middleware/requireAuth';
import { factsRouter } from '../../src/server/api/routes/facts';
import { statsRouter } from '../../src/server/api/routes/stats';
import { SESSION_COOKIE } from '../../src/shared/constants';

let server: Server;
let baseUrl: string;
let cookie: string;
const errors: unknown[] = [];
const fact = (id: string, text: string, messageIds: string[], authorIds: string[], subjectIds: string[] = []): Fact => ({
  id, text, metadata: { guildId: 'guild', channelId: 'channel', messageIds, authorIds, subjectIds, channelRefs: [],
    referencedFactIds: [], timePeriodStart: 100, timePeriodEnd: 200, source: 'auto', createdAt: 200 },
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/facts', requireAuth, factsRouter);
  app.use('/stats', requireAuth, statsRouter);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    errors.push(error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.$client.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  errors.length = 0;
  for (const table of [cachedMessages, factIndex, replyLog, sessions, settings]) db.delete(table).run();
  cookie = `${SESSION_COOKIE}=${createSession()}`;
  updateSettings({ factSearchTopK: 7 });
  state.facts = [
    fact('first', '<@111> and <@222> agreed.', ['2', '1', 'missing'], ['111'], ['111', '222']),
    fact('second', '<@111> owns a dog.', ['1'], ['111'], ['111']),
    fact('third', '<@999> monitors this channel.', [], [], ['999']),
  ];
  state.search.mockImplementation(async () => state.facts.map((entry) => ({ ...entry, distance: 0.1 })));
  state.page.mockImplementation(async ({ page, pageSize, authorId }: { page: number; pageSize: number; authorId?: string }) => {
    const filtered = authorId ? state.facts.filter((entry) => entry.metadata.authorIds.includes(authorId)) : state.facts;
    return { facts: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length };
  });
  state.all.mockImplementation(async () => state.facts);
  state.count.mockImplementation(async () => state.facts.length);
  state.remove.mockImplementation(async (id: string) => state.facts.some((entry) => entry.id === id));
  // The authors list and the dashboard's message counter are answered from the
  // mirror rather than by reading every fact out of Chroma.
  indexFacts(state.facts);
  cacheMessages([
    { messageId: '1', channelId: 'channel', guildId: 'guild', authorId: '111', authorUsername: 'Alice Old', content: 'First source', messageCreatedAt: 1000 },
    { messageId: '2', channelId: 'channel', guildId: 'guild', authorId: '111', authorUsername: 'Alice Current', content: 'Second source', messageCreatedAt: 2000 },
    { messageId: '99', channelId: 'other', guildId: 'guild', authorId: '222', authorUsername: 'Bob Cached', content: 'Not a source for these facts', messageCreatedAt: 3000 },
  ]);
});

const request = (path: string, options: { method?: string; body?: unknown; cookie?: string | null } = {}) => fetch(`${baseUrl}${path}`, {
  method: options.method ?? 'GET',
  headers: { 'Content-Type': 'application/json', ...(options.cookie === null ? {} : { Cookie: options.cookie ?? cookie }) },
  body: options.body === undefined ? undefined : JSON.stringify(options.body),
});

describe('fact and statistics authorization', () => {
  it.each([
    ['/facts', 'GET'], ['/facts/authors', 'GET'], ['/facts/search', 'POST'], ['/facts/first', 'DELETE'], ['/stats', 'GET'],
  ])('protects %s (%s), including cached source message text', async (path, method) => {
    const response = await request(path, { method, body: method === 'POST' ? { query: 'private fact' } : undefined, cookie: null });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: 'Not authenticated' });
    expect(state.search).not.toHaveBeenCalled();
    expect(state.page).not.toHaveBeenCalled();
    expect(state.all).not.toHaveBeenCalled();
    expect(state.count).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it('rejects an unknown or expired session cookie', async () => {
    expect((await request('/facts', { cookie: `${SESSION_COOKIE}=unknown` })).status).toBe(401);
    db.update(sessions).set({ expiresAt: Date.now() - 1 }).run();
    expect((await request('/stats')).status).toBe(401);
  });
});

describe('fact search and browsing HTTP API', () => {
  it('trims search input, uses configured topK and returns ordered sources plus resolved names', async () => {
    const response = await request('/facts/search', { method: 'POST', body: { query: '  Bob owns what?  ' } });
    expect(response.status).toBe(200);
    expect(state.search).toHaveBeenCalledWith('Bob owns what?', 7);
    const body = await response.json();
    expect(body.data[0].sourceMessages.map((entry: { messageId: string }) => entry.messageId)).toEqual(['2', '1']);
    expect(body.data[0].sourceMessages[0]).toMatchObject({ content: 'Second source', jumpLink: 'https://discord.com/channels/guild/channel/2' });
    expect(body.data[0].mentionNames).toEqual({ '111': 'Alice Current', '222': 'Bob Cached' });
    expect(body.data[2].mentionNames).toEqual({ '999': 'Big Yahu' });
    expect(body.data[0].distance).toBe(0.1);
  });

  it.each([{}, [], { query: '' }, { query: '  ' }, { query: 123 }])('rejects a missing or malformed search query %#', async (body) => {
    const response = await request('/facts/search', { method: 'POST', body });
    expect(response.status).toBe(400);
    expect(state.search).not.toHaveBeenCalled();
  });

  it.each(['5', 1.2, null, true])('rejects a non-integer topK %#', async (topK) => {
    const response = await request('/facts/search', { method: 'POST', body: { query: 'Question', topK } });
    expect(response.status).toBe(400);
    expect(state.search).not.toHaveBeenCalled();
  });

  it.each([[-5, 1], [0, 1], [999, 50]])('clamps topK %s to %s', async (topK, expected) => {
    expect((await request('/facts/search', { method: 'POST', body: { query: 'Question', topK } })).status).toBe(200);
    expect(state.search).toHaveBeenCalledWith('Question', expected);
  });

  it('applies page and person filters and returns the pagination contract', async () => {
    const response = await request('/facts?page=2&pageSize=1&authorId=111');
    expect(response.status).toBe(200);
    expect(state.page).toHaveBeenCalledWith({ page: 2, pageSize: 1, authorId: '111', types: [] });
    expect(await response.json()).toMatchObject({ success: true, data: {
      total: 2, page: 2, pageSize: 1, facts: [{ id: 'second', distance: null, sourceMessages: [{ messageId: '1' }] }],
    } });
  });

  it('uses defaults and permits empty out-of-range pages', async () => {
    await request('/facts');
    expect(state.page).toHaveBeenCalledWith({ page: 1, pageSize: 25, authorId: undefined, types: [] });
    expect(await (await request('/facts?page=9')).json()).toMatchObject({ data: { facts: [], total: 3, page: 9 } });
  });

  it.each([
    'page=0', 'page=-1', 'page=1.5', 'page=NaN', 'page=',
    'pageSize=0', 'pageSize=101', 'pageSize=1.5', 'pageSize=abc',
    'page=9007199254740992', `page=${'9'.repeat(400)}`,
  ])('rejects malformed or unsafe pagination: %s', async (query) => {
    expect((await request(`/facts?${query}`)).status).toBe(400);
    expect(state.page).not.toHaveBeenCalled();
  });

  it('lists source authors and mentioned subjects with known names and descending fact counts', async () => {
    const response = await request('/facts/authors');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: [
      { authorId: '111', authorUsername: 'Alice Current', factCount: 2 },
      { authorId: '222', authorUsername: 'Bob Cached', factCount: 1 },
      { authorId: '999', authorUsername: 'Big Yahu', factCount: 1 },
    ] });
  });

  it('deletes existing facts and returns 404 for unknown facts', async () => {
    expect(await (await request('/facts/first', { method: 'DELETE' })).json()).toEqual({ success: true, data: { id: 'first' } });
    expect(state.remove).toHaveBeenCalledWith('first');
    const missing = await request('/facts/missing', { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ success: false, error: 'Fact not found' });
  });

  it('forwards asynchronous storage failures to the Express error handler', async () => {
    const failure = new Error('Chroma offline with private implementation details');
    state.search.mockRejectedValueOnce(failure);
    const response = await request('/facts/search', { method: 'POST', body: { query: 'Question' } });
    expect(response.status).toBe(500);
    expect(errors).toEqual([failure]);
    expect(await response.json()).toEqual({ success: false, error: 'Internal server error' });
  });
});

describe('dashboard statistics HTTP API', () => {
  it('counts distinct cached references and returns the five latest replies with jump links', async () => {
    for (let index = 1; index <= 7; index += 1) logReply({
      guildId: 'guild', channelId: 'channel', taggedMessageId: String(index), userId: '111',
      replyMessageId: index === 3 ? null : `reply-${index}`, content: `Reply ${index}`, factIdsUsed: ['first'],
    });
    const response = await request('/stats');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ totalFacts: 3, totalMessagesReferenced: 2, totalReplies: 7 });
    expect(body.data.latestReplies.map((entry: { content: string }) => entry.content)).toEqual(['Reply 7', 'Reply 6', 'Reply 5', 'Reply 4', 'Reply 3']);
    expect(body.data.latestReplies[0].jumpLink).toBe('https://discord.com/channels/guild/channel/reply-7');
    expect(body.data.latestReplies[4].jumpLink).toBeNull();
  });

  it('names whoever tagged the bot, and leaves the id when nobody can be named', async () => {
    // '111' wrote cached messages, so the cache can name them; '777' exists
    // nowhere the server can look, which is the one case the panel shows an id.
    logReply({ guildId: 'guild', channelId: 'channel', taggedMessageId: '1', userId: '111',
      replyMessageId: 'reply-1', content: 'Named', factIdsUsed: [] });
    logReply({ guildId: 'guild', channelId: 'channel', taggedMessageId: '2', userId: '777',
      replyMessageId: 'reply-2', content: 'Nameless', factIdsUsed: [] });
    const body = await (await request('/stats')).json();
    expect(body.data.latestReplies.map((entry: { userName: string }) => entry.userName)).toEqual(['777', 'Alice Current']);
  });

  it('returns empty statistics consistently', async () => {
    state.facts = [];
    db.delete(factIndex).run();
    expect(await (await request('/stats')).json()).toEqual({ success: true, data: {
      totalFacts: 0, totalMessagesReferenced: 0, totalReplies: 0, latestReplies: [],
    } });
  });

  it('forwards a Chroma count failure to Express instead of returning partial success', async () => {
    const failure = new Error('Chroma count failed');
    state.count.mockRejectedValueOnce(failure);
    expect((await request('/stats')).status).toBe(500);
    expect(errors).toEqual([failure]);
  });
});
