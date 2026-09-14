import { classifyOpenRouterFailure, describeOpenRouterFailure, readOpenRouterFailure } from './openrouterErrors';
import { BillingError, OverloadedError } from './errors';
import { capabilitiesOf } from './catalog';
import { retryDelay } from './retry';
import { getSettings } from '../db/repositories/settingsRepo';
import {
  allTaskModelsRetired,
  recordTaskFailure,
  retireModelEverywhere,
  selectTaskCandidates,
} from '../db/repositories/taskModelsRepo';
import type { TaskModel } from '@shared/types';

/**
 * Walking a task's model list, shared by every kind of call.
 *
 * What happens when one fails is the same whether the answer is a structured
 * document or a reply with tools: move to the next model on a transient
 * failure, rest one that keeps failing, retire one that does not exist, and
 * stop everything at once when the key cannot pay.
 */

export interface PoolCandidate extends TaskModel {
  /** False when this model cannot see pictures, so the request goes without them. */
  sendImages: boolean;
}

export interface PoolRun<T> {
  /** There are pictures to send, so image-capable models are tried first. */
  withImages?: boolean;
  signal?: AbortSignal;
  /** An error the caller handles itself, rather than a reason to try another model. */
  rethrow?: (error: unknown) => boolean;
  attempt: (candidate: PoolCandidate) => Promise<T>;
}

/**
 * The list, with models that can see pictures moved ahead of those that cannot
 * when there are pictures to send. A text-only model is still tried, last and
 * without them, because an answer without the pictures beats no answer. A model
 * whose capabilities are unknown counts as able: the catalog being unreachable
 * must not strip every picture from every call.
 */
async function candidatesFor(task: string, withImages: boolean): Promise<PoolCandidate[]> {
  const live = selectTaskCandidates(task);
  if (!withImages) return live.map((entry) => ({ ...entry, sendImages: false }));
  const sees = await Promise.all(live.map(async (entry) =>
    (await capabilitiesOf(entry.model, entry.upstream).catch(() => null))?.images ?? true));
  return [
    ...live.filter((_, index) => sees[index]).map((entry) => ({ ...entry, sendImages: true })),
    ...live.filter((_, index) => !sees[index]).map((entry) => ({ ...entry, sendImages: false })),
  ];
}

export async function runOnPool<T>(task: string, run: PoolRun<T>): Promise<T> {
  run.signal?.throwIfAborted();
  const { retryAttempts, retryDelayMs } = getSettings();
  const tried: string[] = [];
  let lastError: unknown;

  for (let pass = 1; pass <= retryAttempts + 1; pass += 1) {
    const candidates = await candidatesFor(task, run.withImages ?? false);
    if (candidates.length === 0) {
      throw new Error(allTaskModelsRetired(task)
        ? `Every ${task} model has been retired for not existing — press Reset errors in Settings, or add a model that does`
        : `No ${task} models are configured — add one in Settings`);
    }

    for (const candidate of candidates) {
      try {
        return await run.attempt(candidate);
      } catch (error) {
        // Cancellation is not a model failure and must not walk the list.
        run.signal?.throwIfAborted();
        if (run.rethrow?.(error)) throw error;

        const kind = classifyOpenRouterFailure(error);
        const description = describeOpenRouterFailure(error);
        if (kind === 'billing') {
          console.error(`[ai] ${task}: ${candidate.model} refused on billing (${description}) — stopping, the key is out of credit`);
          throw new BillingError(readOpenRouterFailure(error).detail);
        }
        if (kind === 'fatal') {
          console.error(`[ai] ${task}: ${candidate.model} failed unrecoverably (${description}) — not trying another model`);
          throw error;
        }

        tried.push(candidate.model);
        lastError = error;
        if (kind === 'gone') {
          retireModelEverywhere(candidate.model, description);
          console.error(`[ai] ${task}: ${candidate.model} does not exist (${description}) — retired from every list until Reset errors`);
          continue;
        }
        const resting = recordTaskFailure(task, candidate.model, description);
        console.warn(`[ai] ${task}: ${candidate.model} failed (${description})${resting ? ' — resting it and moving on' : ' — trying the next model'}`);
      }
    }

    if (pass <= retryAttempts) {
      console.warn(`[ai] ${task}: every model failed on pass ${pass}/${retryAttempts + 1}, waiting ${retryDelayMs}ms`);
      await retryDelay(retryDelayMs, pass - 1, run.signal);
    }
  }

  throw new OverloadedError(tried, lastError);
}
