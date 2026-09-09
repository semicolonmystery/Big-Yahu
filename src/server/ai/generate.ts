import { ApiError } from '@google/genai';
import type { GenerateContentConfig, ContentListUnion, GenerateContentResponse } from '@google/genai';
import { ai } from './client';
import { getSettings } from '../db/repositories/settingsRepo';
import { recordFailure, recordSuccess, selectCandidates } from '../db/repositories/chatModelsRepo';
import { RETRYABLE_STATUSES } from '@shared/constants';

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

function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) return RETRYABLE_STATUSES.has(error.status);
  // The SDK sometimes surfaces transport failures as plain errors with the status in the text.
  const text = error instanceof Error ? error.message : String(error);
  return /\b(429|503|504)\b|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(text);
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.status}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
        const response = await ai.models.generateContent({ model: candidate.model, contents, config });
        recordSuccess(candidate.model);
        return response;
      } catch (error) {
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
      await sleep(retryDelayMs);
    }
  }

  throw new OverloadedError(tried, lastError);
}
