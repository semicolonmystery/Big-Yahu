import type { EmbeddingFunction, EmbeddingFunctionSpace } from 'chromadb';
import { openrouter } from './openrouter';
import { classifyOpenRouterFailure, describeOpenRouterFailure, readOpenRouterFailure } from './openrouterErrors';
import { BillingError, OverloadedError } from './errors';
import { recordCall } from './usage';
import { retryDelay } from './retry';
import { claimAIRequest } from './requestBudget';
import { getActiveEmbedding, getSettings } from '../db/repositories/settingsRepo';

/** Which model turned text into vectors, and how wide they are. A collection is fixed to one pair. */
export interface EmbeddingConfig {
  model: string;
  dimensions: number;
}

/**
 * Well inside the endpoint's limit of 2,048 inputs. Smaller batches also mean a
 * failure costs less work, and a re-embed checkpoints more often.
 */
const BATCH_SIZE = 100;

/** What new facts are embedded with, as the operator has it configured. */
export function configuredEmbedding(): EmbeddingConfig {
  const { embeddingModel, embeddingDimensions } = getSettings();
  return { model: embeddingModel, dimensions: embeddingDimensions };
}

/**
 * What the collection recall actually searches was built with.
 *
 * It trails the configured pair while a re-embed runs, and that gap is the whole
 * point: a query embedded with one model and compared against vectors from
 * another gives scores that look perfectly reasonable and mean nothing.
 */
export function activeEmbedding(): EmbeddingConfig {
  const active = getActiveEmbedding();
  // Nothing has been embedded yet, so what is configured is what the first fact
  // will be embedded with, and the collection will be built to match.
  if (!active.model || active.dimensions <= 0) return configuredEmbedding();
  return active;
}

/**
 * Shortened vectors come back near unit length but not exactly, and the duplicate
 * threshold is a fixed distance, so they are normalised to keep it meaning the
 * same thing. Scaled first: squaring a very large or very small component can
 * overflow or underflow into a zero vector.
 */
function normalize(vector: number[]): number[] {
  let scale = 0;
  for (const value of vector) scale = Math.max(scale, Math.abs(value));
  const scaled = vector.map((value) => value / scale);
  const magnitude = Math.hypot(...scaled);
  return scaled.map((value) => value / magnitude);
}

async function embedBatch(batch: string[], config: EmbeddingConfig): Promise<number[][]> {
  const { retryAttempts, retryDelayMs } = getSettings();

  for (let attempt = 0; ; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await openrouter().embeddings.create(
        { model: config.model, input: batch, dimensions: config.dimensions },
        { signal: claimAIRequest() },
      );
      recordCall({
        task: 'embeddings', model: config.model, startedAt,
        response: response as unknown as { usage?: unknown }, outcome: 'ok',
      });

      const data = [...response.data].sort((first, second) => first.index - second.index);
      if (data.length !== batch.length) {
        throw new Error(`Asked for ${batch.length} embeddings and got ${data.length}`);
      }
      // Built whole before anything is returned: a half-filled batch handed back
      // after a later entry turns out to be unusable would misalign every vector
      // against its text.
      return data.map((entry) => {
        const values = entry.embedding as unknown as number[];
        if (!Array.isArray(values) || values.length !== config.dimensions
          || values.some((value) => !Number.isFinite(value))
          || !values.some((value) => value !== 0)) {
          throw new Error(`${config.model} returned an unusable embedding`);
        }
        return normalize(values);
      });
    } catch (error) {
      recordCall({ task: 'embeddings', model: config.model, startedAt, outcome: 'error' });
      const kind = classifyOpenRouterFailure(error);
      if (kind === 'billing') throw new BillingError(readOpenRouterFailure(error).detail);
      // There is one embedding model, not a list, so anything that is not worth
      // waiting out is simply the caller's problem.
      if (kind !== 'next-model') throw error;
      if (attempt >= retryAttempts) throw new OverloadedError(Array(attempt + 1).fill(config.model), error);
      console.warn(`[ai] embedding failed (${describeOpenRouterFailure(error)}), retrying`);
      await retryDelay(retryDelayMs, attempt);
    }
  }
}

export async function embedWith(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  if (texts.length === 0) return [];
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    vectors.push(...await embedBatch(texts.slice(start, start + BATCH_SIZE), config));
  }
  return vectors;
}

/**
 * Chroma wants a way to embed text itself. Everything the bot stores comes with
 * its vector already, so this is only reached by a query given as text — and it
 * belongs to one collection's pair, never to whatever is configured today.
 */
export function embeddingFunctionFor(config: EmbeddingConfig): EmbeddingFunction {
  return {
    name: 'openrouter',
    generate: (texts) => embedWith(texts, config),
    defaultSpace: (): EmbeddingFunctionSpace => 'cosine',
    supportedSpaces: (): EmbeddingFunctionSpace[] => ['cosine'],
    getConfig: () => ({ model: config.model, dimensions: config.dimensions }),
  };
}

export function embedDocuments(texts: string[]): Promise<number[][]> {
  return embedWith(texts, activeEmbedding());
}

export function embedQuery(text: string): Promise<number[]> {
  return embedWith([text], activeEmbedding()).then(([vector]) => vector);
}
