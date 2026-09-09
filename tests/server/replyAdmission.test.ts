import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ db: undefined as import('../../src/server/db/client').Db | undefined }));
vi.mock('../../src/server/db/client', async () => {
  if (fixture.db) return { db: fixture.db };
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const schema = await import('../../src/server/db/schema');
  fixture.db = drizzle(new Database(':memory:'), { schema });
  migrate(fixture.db, { migrationsFolder: './drizzle' });
  return { db: fixture.db };
});

import { db } from '../../src/server/db/client';
import { replyAttempts } from '../../src/server/db/schema';
import { RATE_LIMIT_WINDOW_MS } from '../../src/shared/constants';

beforeEach(() => {
  db.delete(replyAttempts).run();
  vi.resetModules();
});
afterAll(() => db.$client.close());

describe('persistent reply attempt reservations', () => {
  it('reserves the same message only once, including simultaneous deliveries and another user ID', async () => {
    const { reserveReplyAttempt } = await import('../../src/server/db/repositories/replyAttemptsRepo');
    const admitted = await Promise.all(Array.from({ length: 12 }, async () => reserveReplyAttempt('same-message', 'alice', 20)));
    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect(reserveReplyAttempt('same-message', 'bob', 20)).toBe(false);
    expect(db.select().from(replyAttempts).all()).toHaveLength(1);
  });

  it('applies the hourly cap to simultaneous distinct messages without charging refused attempts', async () => {
    const { reserveReplyAttempt } = await import('../../src/server/db/repositories/replyAttemptsRepo');
    const admitted = await Promise.all(Array.from({ length: 10 }, async (_, index) => reserveReplyAttempt(`message-${index}`, 'alice', 3)));
    expect(admitted.filter(Boolean)).toHaveLength(3);
    expect(db.select().from(replyAttempts).all()).toHaveLength(3);
    expect(reserveReplyAttempt('bob-message', 'bob', 3)).toBe(true);
  });

  it('disables replies at a zero limit and allows new reservations after the window expires', async () => {
    const { reserveReplyAttempt } = await import('../../src/server/db/repositories/replyAttemptsRepo');
    const start = 1_800_000_000_000;
    expect(reserveReplyAttempt('disabled', 'alice', 0, start)).toBe(false);
    expect(db.select().from(replyAttempts).all()).toHaveLength(0);
    expect(reserveReplyAttempt('old', 'alice', 1, start)).toBe(true);
    expect(reserveReplyAttempt('too-soon', 'alice', 1, start + RATE_LIMIT_WINDOW_MS - 1)).toBe(false);
    expect(reserveReplyAttempt('new', 'alice', 1, start + RATE_LIMIT_WINDOW_MS + 1)).toBe(true);
    expect(db.select().from(replyAttempts).all().map((row) => row.messageId)).toEqual(['new']);
  });

  it('keeps the hourly cap and duplicate protection after admission modules are reloaded', async () => {
    const first = await import('../../src/server/bot/replyAdmission');
    const release = first.admitReply('before-restart', 'alice', 1);
    expect(release).toBeTypeOf('function');
    release!();
    vi.resetModules();
    const second = await import('../../src/server/bot/replyAdmission');
    expect(second.admitReply('after-restart', 'alice', 1)).toBeNull();
    expect(second.admitReply('before-restart', 'bob', 1)).toBeNull();
    expect(db.select().from(replyAttempts).all().map((row) => row.messageId)).toEqual(['before-restart']);
  });
});

describe('active reply admission', () => {
  it('allows one active reply per user and releases that slot without resetting the hourly cap', async () => {
    const { admitReply } = await import('../../src/server/bot/replyAdmission');
    const first = admitReply('message-1', 'alice', 2);
    expect(first).toBeTypeOf('function');
    expect(admitReply('message-2', 'alice', 2)).toBeNull();
    expect(db.select().from(replyAttempts).all()).toHaveLength(1);
    first!();
    const second = admitReply('message-2', 'alice', 2);
    expect(second).toBeTypeOf('function');
    second!();
    expect(admitReply('message-3', 'alice', 2)).toBeNull();
  });

  it('caps global activity at four and makes repeated release calls harmless', async () => {
    const { admitReply } = await import('../../src/server/bot/replyAdmission');
    const releases = ['alice', 'bob', 'carol', 'dave'].map((user) => admitReply(`message-${user}`, user, 10));
    expect(releases.every((release) => typeof release === 'function')).toBe(true);
    expect(admitReply('message-eve', 'eve', 10)).toBeNull();
    expect(db.select().from(replyAttempts).all()).toHaveLength(4);
    releases[0]!();
    releases[0]!();
    const eve = admitReply('message-eve', 'eve', 10);
    expect(eve).toBeTypeOf('function');
    // A double release must not open a fifth concurrent slot.
    expect(admitReply('message-frank', 'frank', 10)).toBeNull();
    for (const release of releases) release!();
    eve!();
    const frank = admitReply('message-frank', 'frank', 10);
    expect(frank).toBeTypeOf('function');
    frank!();
    expect(db.select().from(replyAttempts).all()).toHaveLength(6);
  });
});
