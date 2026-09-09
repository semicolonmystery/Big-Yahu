import type { EmbeddingFunction, EmbeddingFunctionSpace } from 'chromadb';
import { ai } from './client';
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '@shared/constants';

const BATCH_SIZE = 100;

/**
 * Gemini truncates output vectors when outputDimensionality is below the model's
 * native 3072, which leaves them non-unit-length; re-normalising keeps distances
 * comparable to the fixed duplicate threshold.
 */
function normalize(vector: number[]): number[] {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  const magnitude = Math.sqrt(sumOfSquares);
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

async function embed(texts: string[], taskType: string): Promise<number[][]> {
  if (texts.length === 0) return [];

  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const response = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: batch,
      config: { taskType, outputDimensionality: EMBEDDING_DIMENSIONS },
    });

    const embeddings = response.embeddings;
    if (!embeddings || embeddings.length !== batch.length) {
      throw new Error(`Expected ${batch.length} embeddings, received ${embeddings?.length ?? 0}`);
    }
    for (const embedding of embeddings) {
      if (!embedding.values) throw new Error('Gemini returned an embedding with no values');
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
