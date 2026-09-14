import { Router, type Response } from 'express';
import { getSettings, updateSettings, SettingsValidationError } from '../../db/repositories/settingsRepo';
import { latestJob, openJob } from '../../db/repositories/reembedRepo';
import { continueReembed, pauseReembed, planReembed, resetReembed, runReembed, startReembed } from '../../ai/reembed';
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

async function answer(res: Response): Promise<void> {
  res.json({ success: true, data: { ...(await planReembed()), job: statusOf() } satisfies EmbeddingStatus });
}

/** Every control answers with the whole status, so the panel never has to infer it. */
function control(path: string, act: () => Promise<void> | void) {
  settingsRouter.post(path, async (_req, res) => {
    try {
      await act();
      await answer(res);
    } catch (error) {
      console.error(`[settings] ${path} failed:`, error);
      res.status(503).json({ success: false, error: 'Could not reach the fact store. Check that ChromaDB is running.' });
    }
  });
}

// Started only from here. Nothing begins a re-embed on its own: it is long and
// paid, and the operator is the one who decides to spend it.
control('/embedding/reembed', async () => {
  const existing = openJob();
  if (existing) {
    // Already open — continue it rather than opening a second.
    if (existing.status === 'running') void runReembed();
    else continueReembed();
    return;
  }
  await startReembed();
  void runReembed();
});

control('/embedding/pause', () => { pauseReembed(); });
control('/embedding/continue', () => { continueReembed(); });
control('/embedding/reset', async () => { await resetReembed(); });
