import { Router, type Response } from 'express';
import { getSettings, updateSettings, SettingsValidationError } from '../../db/repositories/settingsRepo';
import { latestJob, openJob, resumeJob } from '../../db/repositories/reembedRepo';
import { planReembed, runReembed, startReembed } from '../../ai/reembed';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { AppSettings, EmbeddingStatus } from '@shared/types';

export const settingsRouter = Router();

// Derived so a new setting is accepted as soon as it has a default, rather than
// being silently dropped until someone remembers to update a second list.
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

function readPatch(body: unknown): Partial<AppSettings> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const patch: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (key in body) patch[key] = (body as Record<string, unknown>)[key];
  }
  return patch as Partial<AppSettings>;
}

settingsRouter.get('/', (_req, res) => {
  res.json({ success: true, data: getSettings() });
});

settingsRouter.patch('/', (req, res) => {
  const patch = readPatch(req.body);
  if (!patch) {
    res.status(400).json({ success: false, error: 'Request body must be an object' });
    return;
  }
  try {
    res.json({ success: true, data: updateSettings(patch) });
  } catch (error) {
    if (!(error instanceof SettingsValidationError)) throw error;
    res.status(400).json({ success: false, error: error.message });
  }
});

type JobStatus = NonNullable<EmbeddingStatus['job']>;

function statusOf(): EmbeddingStatus['job'] {
  const job = openJob() ?? latestJob();
  if (!job) return null;
  return {
    id: job.id,
    status: job.status as JobStatus['status'],
    total: job.total,
    copied: job.copied,
    sourceModel: job.sourceModel,
    targetModel: job.targetModel,
    targetDimensions: job.targetDimensions,
    pausesRecall: job.pausesRecall,
    lastError: job.lastError,
  };
}

/**
 * What the store is embedded with, what it should be, and any move in progress.
 *
 * This is the screen an operator opens when memory looks wrong, so an
 * unreachable fact store has to say that plainly rather than arriving as a
 * stack trace about fetch.
 */
settingsRouter.get('/embedding', async (_req, res) => {
  try {
    const plan = await planReembed();
    res.json({ success: true, data: { ...plan, job: statusOf() } satisfies EmbeddingStatus });
  } catch (error) {
    console.error('[settings] could not read the fact store:', error);
    res.status(503).json({ success: false, error: 'Could not reach the fact store. Check that ChromaDB is running.' });
  }
});

settingsRouter.post('/embedding/reembed', async (_req, res) => {
  try {
    await reembed(res);
  } catch (error) {
    console.error('[settings] could not start the re-embed:', error);
    res.status(503).json({ success: false, error: 'Could not reach the fact store. Check that ChromaDB is running.' });
  }
});

async function reembed(res: Response): Promise<void> {
  const existing = openJob();
  if (existing) {
    // Already moving. Nudge the runner in case a restart left it idle.
    void runReembed();
    res.json({ success: true, data: { ...(await planReembed()), job: statusOf() } satisfies EmbeddingStatus });
    return;
  }

  const failed = latestJob();
  if (failed?.status === 'failed') {
    // Resumed rather than restarted: what it already copied stays copied, so a
    // retry does not pay to embed the same facts twice.
    resumeJob(failed.id);
  } else {
    await startReembed();
  }
  void runReembed();
  res.json({ success: true, data: { ...(await planReembed()), job: statusOf() } satisfies EmbeddingStatus });
}
