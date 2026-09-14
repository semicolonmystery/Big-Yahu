import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const fixture = vi.hoisted(() => {
  const guildId = '12345678901234567';
  const channelId = '23456789012345678';
  const channel = { id: channelId, name: 'quiet-channel', type: 0, guildId };
  return { guildId, channelId, channels: new Map([[channelId, channel]]) };
});

vi.mock('../../src/server/env', () => ({ env: { discordGuildId: fixture.guildId } }));
vi.mock('../../src/server/bot/client', () => ({
  discordClient: {
    channels: { cache: fixture.channels },
    guilds: { cache: new Map([[fixture.guildId, { channels: { cache: fixture.channels } }]]) },
    isReady: () => true,
  },
}));
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
import { channelCheckpoints, channelSettings, settings, controllers } from '../../src/server/db/schema';
import { invalidate } from '../../src/server/db/repositories/channelSettingsRepo';
import { channelsRouter } from '../../src/server/api/routes/channels';
import { settingsRouter } from '../../src/server/api/routes/settings';
import { controllersRouter } from '../../src/server/api/routes/controllers';
import { isController } from '../../src/server/db/repositories/controllersRepo';
import { DEFAULT_SETTINGS, DUPLICATE_DISTANCE_MAX, FACT_SEARCH_MAX_DISTANCE_MAX } from '../../src/shared/constants';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/channels', channelsRouter);
  app.use('/settings', settingsRouter);
  app.use('/controllers', controllersRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.$client.close();
});

beforeEach(() => {
  db.delete(channelCheckpoints).run();
  db.delete(channelSettings).run();
  db.delete(settings).run();
  db.delete(controllers).run();
  invalidate();
});

const patch = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const send = (method: string, path: string, body?: unknown) => fetch(`${baseUrl}${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

describe('channel permissions API', () => {
  it('reports the actual opt-in default and registers an idle channel when reading is enabled', async () => {
    const initial = await (await fetch(`${baseUrl}/channels`)).json();
    expect(initial.data.channels).toEqual([{
      channelId: fixture.channelId, name: 'quiet-channel', canReply: true, canExtract: false,
    }]);
    expect(db.select().from(channelCheckpoints).all()).toEqual([]);

    const response = await patch(`/channels/${fixture.channelId}`, { canExtract: true });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ canExtract: true, canReply: true });
    expect(db.select().from(channelCheckpoints).all()).toEqual([{
      channelId: fixture.channelId, guildId: fixture.guildId, lastCheckedAt: null, lastMessageId: null,
    }]);
    expect((await (await fetch(`${baseUrl}/channels`)).json()).data.channels[0].canExtract).toBe(true);
  });

  it('changing only reply does not opt the channel into reading', async () => {
    const response = await patch(`/channels/${fixture.channelId}`, { canReply: false });
    expect((await response.json()).data).toMatchObject({ canExtract: false, canReply: false });
    expect(db.select().from(channelCheckpoints).all()).toEqual([]);
  });

  it('preserves the scan checkpoint when reading is enabled again', async () => {
    const checkpoint = { channelId: fixture.channelId, guildId: fixture.guildId, lastMessageId: '34567890123456789', lastCheckedAt: 1234 };
    db.insert(channelCheckpoints).values(checkpoint).run();
    expect((await patch(`/channels/${fixture.channelId}`, { canExtract: true })).status).toBe(200);
    expect(db.select().from(channelCheckpoints).all()).toEqual([checkpoint]);
  });

  it('hides saved channels from another guild', async () => {
    db.insert(channelSettings).values({ channelId: '99999999999999999', guildId: 'another-guild', canReply: true, canExtract: true, updatedAt: 1 }).run();
    const response = await (await fetch(`${baseUrl}/channels`)).json();
    expect(response.data.channels).toHaveLength(1);
  });

  it.each([[], null, { canExtract: 'yes' }])('rejects malformed permission bodies: %j', async (body) => {
    expect((await patch(`/channels/${fixture.channelId}`, body)).status).toBe(400);
    expect(db.select().from(channelSettings).all()).toEqual([]);
  });
});

describe('settings API validation', () => {
  it.each([
    { timezone: null }, { timezone: 123 }, { timezone: 'Not/A_Zone' },
    { replyLanguage: 'xx-invalid' }, { retryAttempts: 1.5 }, { visionEnabled: 'yes' },
    { overloadMessage: '   ' },
  ])('returns 400 and preserves settings for invalid input: %j', async (body) => {
    await fetch(`${baseUrl}/settings`);
    const response = await patch('/settings', body);
    expect(response.status).toBe(400);
    expect((await response.json()).success).toBe(false);
    expect((await (await fetch(`${baseUrl}/settings`)).json()).data).toEqual(DEFAULT_SETTINGS);
  });

  it('persists valid fields, clamps numeric bounds and ignores unknown properties', async () => {
    const response = await patch('/settings', { timezone: ' Europe/Prague ', maxEscalationDepth: 999, unknown: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.timezone).toBe('Europe/Prague');
    expect(body.data.maxEscalationDepth).toBe(3);
    expect(body.data).not.toHaveProperty('unknown');
    expect((await (await fetch(`${baseUrl}/settings`)).json()).data).toEqual(body.data);
  });

  it('takes a recall ceiling, and 0 to switch it off', async () => {
    expect((await (await patch('/settings', { factSearchMaxDistance: 65 })).json()).data.factSearchMaxDistance).toBe(65);
    expect((await (await patch('/settings', { factSearchMaxDistance: 0 })).json()).data.factSearchMaxDistance).toBe(0);
    expect((await (await patch('/settings', { factSearchMaxDistance: 9999 })).json()).data.factSearchMaxDistance)
      .toBe(FACT_SEARCH_MAX_DISTANCE_MAX);
  });

  it('accepts a new embedding model and width without touching the live store', async () => {
    const body = await (await patch('/settings', { embeddingModel: 'other/embeddings', embeddingDimensions: 512 })).json();
    expect(body.data).toMatchObject({ embeddingModel: 'other/embeddings', embeddingDimensions: 512 });
    // Which model recall is actually on is the job's to change, never a save.
    expect(body.data).not.toHaveProperty('activeEmbeddingModel');
  });

  it('takes a hand-calibrated duplicate distance and holds it inside its bounds', async () => {
    expect((await (await patch('/settings', { duplicateDistance: 40 })).json()).data.duplicateDistance).toBe(40);
    // A distance of 0 would compare nothing; an unbounded one would fold
    // unrelated facts into each other.
    expect((await (await patch('/settings', { duplicateDistance: 0 })).json()).data.duplicateDistance).toBe(1);
    expect((await (await patch('/settings', { duplicateDistance: 500 })).json()).data.duplicateDistance)
      .toBe(DUPLICATE_DISTANCE_MAX);
  });

  it('supports disabling text attachments and clamps their size to the 64 KiB limit', async () => {
    expect((await (await fetch(`${baseUrl}/settings`)).json()).data.textAttachmentMaxKb).toBe(16);
    expect((await (await patch('/settings', { textAttachmentMaxKb: 0 })).json()).data.textAttachmentMaxKb).toBe(0);
    expect((await (await patch('/settings', { textAttachmentMaxKb: 256 })).json()).data.textAttachmentMaxKb).toBe(64);
    expect((await patch('/settings', { textAttachmentMaxKb: '16' })).status).toBe(400);
    expect((await (await fetch(`${baseUrl}/settings`)).json()).data.textAttachmentMaxKb).toBe(64);
  });
});

describe('controller administration', () => {
  const userId = '45678901234567890';

  it('adds, relabels and removes a controller without creating duplicates', async () => {
    expect((await (await fetch(`${baseUrl}/controllers`)).json()).data).toEqual([]);
    const added = await send('POST', '/controllers', { userId: ` ${userId} `, label: ' Moderator ' });
    expect(added.status).toBe(200);
    expect((await added.json()).data).toMatchObject({ userId, label: 'Moderator' });
    expect(isController(userId)).toBe(true);
    expect((await send('POST', '/controllers', { userId, label: 'Owner' })).status).toBe(200);
    const listed = (await (await fetch(`${baseUrl}/controllers`)).json()).data;
    expect(listed).toHaveLength(1);
    expect(listed[0].label).toBe('Owner');
    expect((await send('DELETE', `/controllers/${userId}`)).status).toBe(200);
    expect(isController(userId)).toBe(false);
    expect((await send('DELETE', `/controllers/${userId}`)).status).toBe(404);
  });

  it.each([
    {}, { userId: 'invalid', label: 'Moderator' }, { userId, label: ' ' },
    { userId, label: 'x'.repeat(101) }, { userId: 123456789, label: 'Moderator' },
  ])('rejects invalid controller input: %j', async (body) => {
    expect((await send('POST', '/controllers', body)).status).toBe(400);
    expect(db.select().from(controllers).all()).toHaveLength(0);
  });
});
