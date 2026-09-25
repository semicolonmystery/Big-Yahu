import { Router } from 'express';
import { countFacts, ensureFactIndex } from '../../db/repositories/factsRepo';
import { indexedMessageIds } from '../../db/repositories/factIndexRepo';
import { countDistinctReferencedMessages } from '../../db/repositories/cachedMessagesRepo';
import { countReplies, getLatestReplies } from '../../db/repositories/replyLogRepo';
import { usageSummary } from '../../db/repositories/usageRepo';
import { displayNames } from '../names';
import type { DashboardStats, ReplyLogEntry } from '@shared/types';

export const statsRouter = Router();

statsRouter.get('/', async (_req, res) => {
  await ensureFactIndex();
  const totalFacts = await countFacts();

  // The source messages come from the SQLite mirror: this counter used to read
  // every fact out of Chroma to get at its message ids.
  const totalMessagesReferenced = countDistinctReferencedMessages(indexedMessageIds());
  const totalReplies = countReplies();

  // The log stores the snowflake of whoever tagged the bot, which is right —
  // ids outlive renames — and unreadable in a table, so the name is put on the
  // row here rather than left to a panel that has no Discord to ask.
  const rows = getLatestReplies(5);
  const names = displayNames(rows.map((row) => row.userId));
  const latestReplies: ReplyLogEntry[] = rows.map((row) => ({
    ...row,
    userName: names[row.userId] ?? row.userId,
  }));

  const data: DashboardStats = {
    totalFacts,
    totalMessagesReferenced,
    totalReplies,
    latestReplies,
  };
  res.json({ success: true, data });
});

/** Its own route, so the dashboard's counters never wait on, or fail with, the spend summary. */
statsRouter.get('/usage', (_req, res) => {
  res.json({ success: true, data: usageSummary() });
});
