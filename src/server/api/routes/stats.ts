import { Router } from 'express';
import { countFacts, listAllFacts } from '../../db/repositories/factsRepo';
import { countDistinctReferencedMessages } from '../../db/repositories/cachedMessagesRepo';
import { countReplies, getLatestReplies } from '../../db/repositories/replyLogRepo';
import type { DashboardStats } from '@shared/types';

export const statsRouter = Router();

statsRouter.get('/', async (_req, res) => {
  const [totalFacts, allFacts] = await Promise.all([countFacts(), listAllFacts()]);

  const messageIds = allFacts.flatMap((fact) => fact.metadata.messageIds);
  const totalMessagesReferenced = countDistinctReferencedMessages(messageIds);
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
