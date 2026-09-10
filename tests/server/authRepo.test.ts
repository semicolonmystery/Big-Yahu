import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createAdmin, createSession, destroySession, elevateSession, getAdmin, isSessionElevated, isSessionValid, verifyPassword } from '../../src/server/db/repositories/authRepo';
import { SESSION_TTL_MS } from '../../src/shared/constants';

beforeEach(() => {
  db.delete(sessions).run();
  db.delete(adminUser).run();
});
afterAll(() => db.$client.close());

describe('persisted admin credentials and sessions', () => {
  it('uses a fresh salt for identical passwords and verifies only matching credentials', async () => {
    await createAdmin('admin', 'correct-password');
    const first = getAdmin()!;
    expect(await verifyPassword('admin', 'correct-password')).toBe(true);
    expect(await verifyPassword('admin', 'wrong-password')).toBe(false);
    expect(await verifyPassword('other-user', 'correct-password')).toBe(false);
    db.delete(adminUser).run();
    expect(await verifyPassword('admin', 'correct-password')).toBe(false);
    await createAdmin('admin', 'correct-password');
    expect(getAdmin()!.passwordSalt).not.toBe(first.passwordSalt);
    expect(getAdmin()!.passwordHash).not.toBe(first.passwordHash);
  });

  it('expires a session at its deadline and removes it from storage', () => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const token = createSession();
    expect(db.select().from(sessions).get()).toMatchObject({ createdAt: now, expiresAt: now + SESSION_TTL_MS });
    clock.mockReturnValue(now + SESSION_TTL_MS - 1);
    expect(isSessionValid(token)).toBe(true);
    clock.mockReturnValue(now + SESSION_TTL_MS);
    expect(isSessionValid(token)).toBe(false);
    expect(db.select().from(sessions).all()).toHaveLength(0);
  });

  it('creating a session cleans expired rows without invalidating active sessions', () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    db.insert(sessions).values([
      { token: 'past', createdAt: now - 100, expiresAt: now - 1 },
      { token: 'deadline', createdAt: now - 100, expiresAt: now },
      { token: 'active', createdAt: now - 100, expiresAt: now + 1000 },
    ]).run();
    const token = createSession();
    expect(db.select().from(sessions).all().map((row) => row.token).sort()).toEqual(['active', token].sort());
    destroySession(undefined);
    destroySession('not-found');
    destroySession(token);
    expect(isSessionValid(token)).toBe(false);
    expect(isSessionValid('active')).toBe(true);
    expect(isSessionValid(undefined)).toBe(false);
  });

  it('limits elevation to ten minutes and never lets it outlive the session', async () => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await createAdmin('admin', 'correct-password');
    const token = createSession();
    expect(isSessionElevated(token)).toBe(false);
    expect(await elevateSession(token, 'wrong')).toBe(false);
    expect(await elevateSession(token, 'correct-password')).toBe(true);
    clock.mockReturnValue(now + 10 * 60 * 1000 - 1);
    expect(isSessionElevated(token)).toBe(true);
    clock.mockReturnValue(now + 10 * 60 * 1000);
    expect(isSessionElevated(token)).toBe(false);
    expect(isSessionValid(token)).toBe(true);
    expect(await elevateSession(token, 'correct-password')).toBe(true);
    db.update(sessions).set({ expiresAt: Date.now() }).where(eq(sessions.token, token)).run();
    expect(isSessionElevated(token)).toBe(false);
    expect(await elevateSession(token, 'correct-password')).toBe(false);
    expect(await elevateSession('not-found', 'correct-password')).toBe(false);
    expect(await elevateSession(undefined, 'correct-password')).toBe(false);
    expect(isSessionElevated(undefined)).toBe(false);
  });
});
