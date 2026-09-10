import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';

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
import { adminUser, sessions } from '../../src/server/db/schema';
import { authRouter } from '../../src/server/api/routes/auth';
import { requireAuth } from '../../src/server/api/middleware/requireAuth';
import { requireElevated } from '../../src/server/api/middleware/requireElevated';
import { authRateLimit, clearAttempts } from '../../src/server/api/middleware/authRateLimit';
import { SESSION_COOKIE, SESSION_TTL_MS } from '../../src/shared/constants';

const app = express();
let server: Server;
let baseUrl: string;
const heldResponses: Response[] = [];
const credentials = { username: 'admin', password: 'correct horse battery staple' };
const cookieOf = (response: globalThis.Response) => response.headers.get('set-cookie')!.split(';')[0];
const tokenOf = (cookie: string) => cookie.slice(`${SESSION_COOKIE}=`.length);

beforeAll(async () => {
  app.use(express.json());
  app.use(cookieParser());
  app.use('/auth', authRouter);
  app.get('/protected', requireAuth, (_req, res) => res.json({ success: true }));
  app.get('/elevated', requireAuth, requireElevated, (_req, res) => res.json({ success: true }));
  // A controlled in-flight handler makes the concurrency limit deterministic;
  // all real auth routes below use SQLite and the actual async scrypt function.
  app.post('/held-check', authRateLimit, (_req, res) => { heldResponses.push(res); });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const response of heldResponses.splice(0)) response.end();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.$client.close();
});

beforeEach(() => {
  db.delete(sessions).run();
  db.delete(adminUser).run();
  clearAttempts({ ip: '127.0.0.1' } as Request);
  app.set('trust proxy', 0);
});

const post = (path: string, body: unknown = {}, cookie?: string, headers: Record<string, string> = {}) => fetch(`${baseUrl}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
  body: JSON.stringify(body),
});
const get = (path: string, cookie?: string) => fetch(`${baseUrl}${path}`, { headers: cookie ? { Cookie: cookie } : {} });

describe('admin auth HTTP lifecycle', () => {
  it('supports setup, login, elevation and logout while protecting session and elevated routes', async () => {
    expect(await (await get('/auth/status')).json()).toEqual({ success: true, data: { hasAdmin: false, authenticated: false, username: null } });
    expect((await get('/protected')).status).toBe(401);
    expect((await get('/elevated')).status).toBe(401);

    const setup = await post('/auth/setup', { ...credentials, username: '  admin  ' });
    expect(setup.status).toBe(200);
    expect(await setup.json()).toEqual({ success: true, data: { username: 'admin' } });
    const cookie = cookieOf(setup);
    expect(tokenOf(cookie)).toMatch(/^[a-f0-9]{64}$/);
    expect(setup.headers.get('set-cookie')).toContain('HttpOnly');
    expect(setup.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(setup.headers.get('set-cookie')).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(setup.headers.get('set-cookie')).toContain('Path=/');
    expect(setup.headers.get('set-cookie')).not.toContain('Secure');
    const savedAdmin = db.select().from(adminUser).get()!;
    expect(savedAdmin.passwordHash).toMatch(/^[a-f0-9]{128}$/);
    expect(savedAdmin.passwordHash).not.toContain(credentials.password);
    expect(savedAdmin.passwordSalt).toMatch(/^[a-f0-9]{32}$/);
    expect(await (await get('/auth/status', cookie)).json()).toEqual({ success: true, data: { hasAdmin: true, authenticated: true, username: 'admin' } });
    expect((await get('/protected', cookie)).status).toBe(200);
    expect((await get('/elevated', cookie)).status).toBe(403);

    expect((await post('/auth/elevate', { password: 'wrong' }, cookie)).status).toBe(401);
    expect((await get('/elevated', cookie)).status).toBe(403);
    expect((await post('/auth/elevate', { password: credentials.password }, cookie)).status).toBe(200);
    expect((await get('/elevated', cookie)).status).toBe(200);

    const logout = await post('/auth/logout', {}, cookie);
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=;`);
    expect(logout.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970');
    expect((await get('/protected', cookie)).status).toBe(401);
    expect((await get('/elevated', cookie)).status).toBe(401);
    expect(db.select().from(sessions).all()).toHaveLength(0);
    expect(await (await get('/auth/status')).json()).toEqual({ success: true, data: { hasAdmin: true, authenticated: false, username: null } });

    const login = await post('/auth/login', credentials);
    expect(login.status).toBe(200);
    const newCookie = cookieOf(login);
    expect(newCookie).not.toBe(cookie);
    expect((await get('/protected', newCookie)).status).toBe(200);
    expect((await get('/elevated', newCookie)).status).toBe(403);
  });

  it('returns 409 for both repeated and competing first-run setup without replacing the winner', async () => {
    const results = await Promise.all([
      post('/auth/setup', credentials),
      post('/auth/setup', { username: 'second-admin', password: 'a different password' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = db.select().from(adminUser).get()!;
    expect(db.select().from(adminUser).all()).toHaveLength(1);
    const winnerResponse = results.find((result) => result.status === 200)!;
    expect((await winnerResponse.json()).data.username).toBe(winner.username);
    expect((await results.find((result) => result.status === 409)!.json()).error).toBe('An admin account already exists');
    expect((await post('/auth/setup', { username: 'replacement', password: credentials.password })).status).toBe(409);
    expect(db.select().from(adminUser).get()).toEqual(winner);
    expect(db.select().from(sessions).all()).toHaveLength(1);
  });

  it.each([{}, { username: ' ', password: 'valid-password' }, { username: 'admin', password: 'short' }, { username: 123, password: 'valid-password' }])('rejects malformed setup credentials: %j', async (body) => {
    const response = await post('/auth/setup', body);
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(db.select().from(adminUser).all()).toHaveLength(0);
    expect(db.select().from(sessions).all()).toHaveLength(0);
  });

  it('uses the same 401 response for missing accounts, wrong username, wrong password and malformed login', async () => {
    const absent = await post('/auth/login', credentials);
    const expected = await absent.json();
    expect(absent.status).toBe(401);
    await post('/auth/setup', credentials);
    for (const body of [
      { ...credentials, username: 'nonexistent-user' }, { ...credentials, password: 'wrong' }, {}, { username: 'admin', password: 123 },
    ]) {
      const response = await post('/auth/login', body);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(expected);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(db.select().from(sessions).all()).toHaveLength(1);
  });

  it('rejects elevation without a current session even when the password is correct', async () => {
    const setup = await post('/auth/setup', credentials);
    const cookie = cookieOf(setup);
    expect((await post('/auth/elevate', { password: credentials.password })).status).toBe(401);
    expect((await post('/auth/elevate', { password: credentials.password }, `${SESSION_COOKIE}=unknown-token`)).status).toBe(401);
    db.update(sessions).set({ expiresAt: Date.now() - 1 }).where(eq(sessions.token, tokenOf(cookie))).run();
    expect((await post('/auth/elevate', { password: credentials.password }, cookie)).status).toBe(401);
    expect((await get('/protected', cookie)).status).toBe(401);
    expect(db.select().from(sessions).all()).toHaveLength(0);
  });

  it('sets Secure behind a trusted HTTPS proxy but ignores untrusted forwarded protocol', async () => {
    const direct = await post('/auth/setup', credentials, undefined, { 'X-Forwarded-Proto': 'https' });
    expect(direct.headers.get('set-cookie')).not.toContain('Secure');
    app.set('trust proxy', 1);
    const proxied = await post('/auth/login', credentials, undefined, { 'X-Forwarded-Proto': 'https' });
    expect(proxied.headers.get('set-cookie')).toContain('Secure');
    expect(proxied.headers.get('set-cookie')).toContain('HttpOnly');
  });
});

describe('auth HTTP rate limits', () => {
  it('blocks attempt eleven with Retry-After, ignores spoofed X-Forwarded-For, and permits login after the window', async () => {
    await post('/auth/setup', credentials);
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await post('/auth/login', { ...credentials, password: 'wrong' }, undefined, { 'X-Forwarded-For': `198.51.100.${attempt + 1}` });
      expect(response.status).toBe(401);
    }
    const blocked = await post('/auth/login', credentials);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(blocked.headers.get('retry-after'))).toBeLessThanOrEqual(900);
    expect(blocked.headers.get('set-cookie')).toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * 60 * 1000 + 1);
    expect((await post('/auth/login', credentials)).status).toBe(200);
  });

  it('clears failed attempts after a successful login', async () => {
    await post('/auth/setup', credentials);
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let attempt = 0; attempt < 9; attempt++) {
        expect((await post('/auth/login', { ...credentials, password: 'wrong' })).status).toBe(401);
      }
      expect((await post('/auth/login', credentials)).status).toBe(200);
    }
  });

  it('limits in-flight checks and releases capacity once responses finish', async () => {
    const pending = Array.from({ length: 4 }, () => post('/held-check'));
    try {
      await vi.waitFor(() => expect(heldResponses).toHaveLength(4));
      expect((await post('/auth/login', credentials)).status).toBe(429);
    } finally {
      for (const response of heldResponses.splice(0)) response.status(204).end();
      await Promise.all(pending);
    }
    expect((await post('/auth/setup', credentials)).status).toBe(200);
  });
});
