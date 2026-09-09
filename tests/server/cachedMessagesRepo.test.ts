import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const fixture = vi.hoisted(() => ({ sqlite: null as unknown as Database.Database }));
vi.mock('../../src/server/db/client', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('../../src/server/db/schema');
  fixture.sqlite = new Database(':memory:');
  fixture.sqlite.exec(`CREATE TABLE cached_messages (
    message_id TEXT PRIMARY KEY NOT NULL, channel_id TEXT NOT NULL, guild_id TEXT NOT NULL,
    author_id TEXT NOT NULL, author_username TEXT NOT NULL, content TEXT NOT NULL, message_created_at INTEGER NOT NULL
  )`);
  return { db: drizzle(fixture.sqlite, { schema }) };
});

import { cacheMessages, getMessages } from '../../src/server/db/repositories/cachedMessagesRepo';

const row = (messageId: string) => ({
  messageId, channelId: 'channel', guildId: 'guild', authorId: 'author', authorUsername: 'original',
  content: 'Original message', messageCreatedAt: 123,
});

beforeEach(() => fixture.sqlite.exec('DELETE FROM cached_messages'));
afterAll(() => fixture.sqlite.close());

describe('message cache', () => {
  it('refreshes edited message text and usernames without duplicating the source', () => {
    cacheMessages([row('1')]);
    cacheMessages([{ ...row('1'), content: 'Edited message\nAttachment text', authorUsername: 'renamed' }]);
    expect(getMessages(['1'])).toEqual([{
      ...row('1'), content: 'Edited message\nAttachment text', authorUsername: 'renamed',
      jumpLink: 'https://discord.com/channels/guild/channel/1',
    }]);
  });

  it('chunks writes and reads that exceed SQLite parameter limits', () => {
    cacheMessages(Array.from({ length: 5001 }, (_, index) => row(String(index))));
    const ids = Array.from({ length: 40000 }, (_, index) => String(index));
    const found = getMessages([...ids, '1', '2']);
    expect(found).toHaveLength(5001);
    expect(new Set(found.map((message) => message.messageId)).size).toBe(5001);
  });

  it('rolls back all write chunks when a later chunk is invalid', () => {
    const valid = Array.from({ length: 500 }, (_, index) => row(String(index)));
    expect(() => cacheMessages([...valid, { ...row('invalid'), content: null as unknown as string }])).toThrow();
    expect(getMessages(valid.map((message) => message.messageId))).toEqual([]);
  });
});
