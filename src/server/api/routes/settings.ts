import { Router, type Request, type Response } from 'express';
import { getSettings, updateSettings, SettingsValidationError } from '../../db/repositories/settingsRepo';
import { latestJob, openJob } from '../../db/repositories/reembedRepo';
import { continueReembed, pauseReembed, planReembed, resetReembed, runReembed, startReembed } from '../../ai/reembed';
import { DEFAULT_BUNDLE_SIZE, UNTYPED_FILTER, planCleanup, startCleanup } from '../../ai/factCleanup';
import { factTypeIds } from '../../db/repositories/factTypesRepo';
import { bundleCount, clearBundles } from '../../db/repositories/messageBundlesRepo';
import { listTaskModels } from '../../db/repositories/taskModelsRepo';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { AppSettings, BundlingStatus, CleanupStatus, EmbeddingStatus } from '@shared/types';

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
    // Bundles of five and bundles of two are indistinguishable once they are in
    // the table, and a request mixing the two caches nothing while looking like
    // it should. So the size changing throws them all away — which is safe,
    // since a bundle is only a record of where a cut was, and costly enough in
    // lost cache hits that the panel asks before sending it.
    const before = getSettings();
    const clearing = patch.messageBundleSize !== undefined && patch.messageBundleSize !== before.messageBundleSize;
    const updated = updateSettings(patch);
    if (clearing && updated.messageBundleSize !== before.messageBundleSize) {
      clearBundles();
      console.log(`[bundles] bundle size ${before.messageBundleSize} -> ${updated.messageBundleSize}; every bundle dropped`);
    }
    res.json({ success: true, data: updated });
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
    kind: job.kind === 'cleanup' ? 'cleanup' : 'reembed',
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
function control(path: string, act: (req: Request) => Promise<void> | void) {
  settingsRouter.post(path, async (req, res) => {
    try {
      await act(req);
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

/**
 * The cleanup pass shares the job runner, and therefore the controls: pause,
 * continue and reset already act on whichever job is open. Only starting one
 * differs, because a cleanup chooses what it goes over.
 */
settingsRouter.get('/cleanup', async (req, res) => {
  const types = readTypes(req.query.types);
  try {
    res.json({ success: true, data: { ...(await planCleanup(types)), job: statusOf() } satisfies CleanupStatus });
  } catch (error) {
    console.error('[settings] could not read the fact store:', error);
    res.status(503).json({ success: false, error: 'Could not reach the fact store. Check that ChromaDB is running.' });
  }
});

function readTypes(value: unknown): string[] {
  const raw = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  const known = new Set([UNTYPED_FILTER, ...factTypeIds()]);
  return [...new Set(raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => known.has(entry)))];
}

// Started only from here, like the re-embed: it is long and paid, and nothing
// in this codebase spends somebody's money without them pressing something.
control('/cleanup/start', async (req) => {
  const existing = openJob();
  if (existing) {
    if (existing.status === 'running') void runReembed();
    else continueReembed();
    return;
  }
  const body = (req.body ?? {}) as { types?: unknown; bundleSize?: unknown };
  const started = await startCleanup(readTypes(body.types), Number(body.bundleSize) || DEFAULT_BUNDLE_SIZE);
  if (started) void runReembed();
});

control('/embedding/pause', () => { pauseReembed(); });
control('/embedding/continue', () => { continueReembed(); });
control('/embedding/reset', async () => { await resetReembed(); });


/**
 * Whether bundling will actually pay, and what is stopping it.
 *
 * A cached prefix belongs to one model on one host. The reply, the topic call
 * and the periodic fact extraction all read the same channel's history, so
 * bundles cut for one are worth nothing to another unless the three answer on
 * the same model at the same host — the work would be done and the saving would
 * not arrive. The panel says which of them disagree rather than warning in
 * general, because "check your models" is not something anybody can act on.
 */
settingsRouter.get('/bundling', (_req, res) => {
  const SHARING: Array<[string, string]> = [
    ['reply', 'the reply'],
    ['topicExtraction', 'topic extraction'],
    ['factExtraction', 'fact extraction'],
  ];
  const heads = SHARING.map(([task, label]) => {
    const [first] = listTaskModels(task);
    return { task, label, model: first?.model ?? '', upstream: first?.upstream ?? '' };
  });

  const present = heads.filter((head) => head.model);
  const target = present[0];
  const differing = present
    .filter((head) => head.model !== target?.model || head.upstream !== target?.upstream)
    .map((head) => `${head.label} (${head.model}${head.upstream ? ` on ${head.upstream}` : ''})`);

  res.json({
    success: true,
    data: {
      bundles: bundleCount(),
      sharedModel: target ? `${target.model}${target.upstream ? ` on ${target.upstream}` : ''}` : '',
      differing,
    } satisfies BundlingStatus,
  });
});
