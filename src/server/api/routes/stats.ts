import { Router } from 'express';
import { countFacts, ensureFactIndex } from '../../db/repositories/factsRepo';
import { indexedMessageIds } from '../../db/repositories/factIndexRepo';
import { countDistinctReferencedMessages } from '../../db/repositories/cachedMessagesRepo';
import { countReplies, getLatestReplies } from '../../db/repositories/replyLogRepo';
import { usageSummary } from '../../db/repositories/usageRepo';
import type { DashboardStats } from '@shared/types';

export const statsRouter = Router();

statsRouter.get('/', async (_req, res) => {
  await ensureFactIndex();
  const totalFacts = await countFacts();

  // The source messages come from the SQLite mirror: this counter used to read
  // every fact out of Chroma to get at its message ids.
  const totalMessagesReferenced = countDistinctReferencedMessages(indexedMessageIds());
  const totalReplies = countReplies();
  const latestReplies = getLatestReplies(5);

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
