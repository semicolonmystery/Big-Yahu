import { ApiError } from '@google/genai';
import type { GenerateContentConfig, ContentListUnion, GenerateContentResponse } from '@google/genai';
import { ai } from './client';
import { getSettings } from '../db/repositories/settingsRepo';
import { recordFailure, recordSuccess, selectCandidates } from '../db/repositories/chatModelsRepo';
import { isRetryable, retryDelay } from './retry';
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

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.status}: ${error.message}`;
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
      throw new Error('No chat models are configured — add one in Settings');
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
        if (!isRetryable(error)) throw error;

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
