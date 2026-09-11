import { ApiError } from '@google/genai';
import type { GenerateContentConfig, ContentListUnion, GenerateContentResponse } from '@google/genai';
import { ai } from './client';
import { getSettings } from '../db/repositories/settingsRepo';
import { allRetired, recordFailure, recordSuccess, retireModel, selectCandidates } from '../db/repositories/chatModelsRepo';
import { retryDelay } from './retry';
import { classifyFailure, describeFailure, readApiFailure } from './apiErrors';
import { claimAIRequest } from './requestBudget';

/** What a caller gets when it asks for nothing in particular. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * The bound on any one generation, so a runaway answer cannot bill forever.
 * It is deliberately far above the default: this is the ceiling, not the size.
 * A caller whose answer is legitimately long — extracting facts from a full
 * page of messages — raises its own budget beneath it.
 *
 * On Gemini 3 thinking models this budget covers thinking tokens as well as
 * output, so a reasoning-heavy call can spend most of it before writing a
 * character and return valid-looking JSON cut off mid-document.
 */
const MAX_OUTPUT_TOKENS_CEILING = 65_536;

/** Thrown once every model has been tried and none answered. */
export class OverloadedError extends Error {
  readonly attempts: number;
  readonly triedModels: string[];

  constructor(triedModels: string[], cause: unknown) {
    super(`No chat model answered after trying ${triedModels.join(', ') || 'none'}`, { cause });
    this.name = 'OverloadedError';
    this.attempts = triedModels.length;
    this.triedModels = triedModels;
  }
}

/**
 * The key cannot pay, so no model behind it can answer.
 *
 * Thrown instead of falling through the pool: every model shares the billing
 * account, so trying the next one is guaranteed to fail the same way, several
 * seconds later. It is also not the model's fault, so nothing is recorded
 * against it and nothing gets rested for being on a key that ran out.
 */
export class BillingError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`The Gemini key cannot pay for this request: ${detail}`);
    this.name = 'BillingError';
    this.detail = detail;
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return describeFailure(error);
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a request against the model pool, best-weighted first, moving to the
 * next model when one fails transiently rather than hammering the same one. A
 * model that fails repeatedly is put to rest by the repository. Bad requests
 * are not a model's fault and fail immediately.
 */
export async function generate(
  contents: ContentListUnion,
  config: GenerateContentConfig,
): Promise<GenerateContentResponse> {
  config.abortSignal?.throwIfAborted();
  const { retryAttempts, retryDelayMs } = getSettings();
  const passes = retryAttempts + 1;
  const tried: string[] = [];
  let lastError: unknown;

  for (let pass = 1; pass <= passes; pass += 1) {
    const candidates = selectCandidates();
    if (candidates.length === 0) {
      // Distinguished so the log does not claim the pool is empty when in fact
      // every model in it was retired for not existing.
      throw new Error(allRetired()
        ? 'Every chat model has been retired for not existing — press Reset errors in Settings, or add a model that does'
        : 'No chat models are configured — add one in Settings');
    }

    for (const candidate of candidates) {
      try {
        config.abortSignal?.throwIfAborted();
        const signal = claimAIRequest();
        const response = await ai.models.generateContent({ model: candidate.model, contents, config: {
          ...config,
          maxOutputTokens: Math.min(config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_CEILING),
          abortSignal: config.abortSignal ? AbortSignal.any([signal, config.abortSignal]) : signal,
        } });
        recordSuccess(candidate.model);
        return response;
      } catch (error) {
        // The SDK can replace a caller's cancellation reason with AbortError.
        // Cancellation is not a model failure and must not trigger fallback.
        config.abortSignal?.throwIfAborted();

        // Every failure reaches the console, whatever is done about it — the
        // ones that used to be rethrown in silence were the hardest to diagnose.
        const kind = classifyFailure(error);
        if (kind === 'billing') {
          const failure = readApiFailure(error);
          console.error(`[ai] ${candidate.model} refused on billing (${describe(error)}) — stopping, the whole key is out`);
          throw new BillingError(failure.detail);
        }
        if (kind === 'fatal') {
          console.error(`[ai] ${candidate.model} failed unrecoverably (${describe(error)}) — not trying another model`);
          throw error;
        }
        if (kind === 'gone') {
          // Retired rather than rested: it will not come back on a timer, so a
          // rest period only means trying a model that does not exist, forever.
          retireModel(candidate.model, describe(error));
          lastError = error;
          tried.push(candidate.model);
          console.error(
            `[ai] ${candidate.model} does not exist (${describe(error)})`
              + ' — retired from the pool until Reset errors in Settings',
          );
          continue;
        }

        lastError = error;
        tried.push(candidate.model);
        const resting = recordFailure(candidate.model, describe(error));
        console.warn(
          `[ai] ${candidate.model} failed (${describe(error)})`
            + (resting ? ' — resting it and moving on' : ' — trying the next model'),
        );
      }
    }

    if (pass < passes) {
      console.warn(`[ai] every model failed on pass ${pass}/${passes}, waiting ${retryDelayMs}ms`);
      await retryDelay(retryDelayMs, pass - 1, config.abortSignal);
    }
  }

  throw new OverloadedError(tried, lastError);
}
