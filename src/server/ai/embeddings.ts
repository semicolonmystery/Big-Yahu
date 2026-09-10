import type { EmbeddingFunction, EmbeddingFunctionSpace } from 'chromadb';
import { ai } from './client';
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '@shared/constants';
import { getSettings } from '../db/repositories/settingsRepo';
import { isRetryable, retryDelay } from './retry';
import { claimAIRequest } from './requestBudget';
import { OverloadedError } from './generate';

const BATCH_SIZE = 100;

/**
 * Gemini truncates output vectors when outputDimensionality is below the model's
 * native 3072, which leaves them non-unit-length; re-normalising keeps distances
 * comparable to the fixed duplicate threshold.
 */
function normalize(vector: number[]): number[] {
  // Scale first: squaring a finite but very large/small component can overflow
  // or underflow, silently producing a zero or non-unit vector.
  let scale = 0;
  for (const value of vector) scale = Math.max(scale, Math.abs(value));
  const scaled = vector.map((value) => value / scale);
  const magnitude = Math.hypot(...scaled);
  return scaled.map((value) => value / magnitude);
}

async function embed(texts: string[], taskType: string): Promise<number[][]> {
  if (texts.length === 0) return [];

  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const { retryAttempts, retryDelayMs } = getSettings();
    let response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await ai.models.embedContent({
          model: EMBEDDING_MODEL, contents: batch,
          config: { taskType, outputDimensionality: EMBEDDING_DIMENSIONS, abortSignal: claimAIRequest() },
        });
        break;
      } catch (error) {
        if (!isRetryable(error)) throw error;
        if (attempt >= retryAttempts) throw new OverloadedError(Array(attempt + 1).fill(EMBEDDING_MODEL), error);
        await retryDelay(retryDelayMs, attempt);
      }
    }

    const embeddings = response.embeddings;
    if (!embeddings || embeddings.length !== batch.length) {
      throw new Error(`Expected ${batch.length} embeddings, received ${embeddings?.length ?? 0}`);
    }
    for (const embedding of embeddings) {
      if (!embedding.values || embedding.values.length !== EMBEDDING_DIMENSIONS
        || embedding.values.some((value) => !Number.isFinite(value))
        || !embedding.values.some((value) => value !== 0)) throw new Error('Gemini returned an invalid embedding');
      vectors.push(normalize(embedding.values));
    }
  }
  return vectors;
}

export const geminiEmbeddingFunction: EmbeddingFunction = {
  name: 'gemini',
  generate: (texts) => embed(texts, 'RETRIEVAL_DOCUMENT'),
  generateForQueries: (texts) => embed(texts, 'RETRIEVAL_QUERY'),
  defaultSpace: (): EmbeddingFunctionSpace => 'cosine',
  supportedSpaces: (): EmbeddingFunctionSpace[] => ['cosine'],
  getConfig: () => ({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS }),
};

export function embedDocuments(texts: string[]): Promise<number[][]> {
  return embed(texts, 'RETRIEVAL_DOCUMENT');
}

export function embedQuery(text: string): Promise<number[]> {
  return embed([text], 'RETRIEVAL_QUERY').then(([vector]) => vector);
}
