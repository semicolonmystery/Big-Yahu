import { ChromaClient, type Collection } from 'chromadb';
import { env } from '../env';
import { geminiEmbeddingFunction } from '../ai/embeddings';
import { FACTS_COLLECTION } from '@shared/constants';

export const chroma = new ChromaClient({
  host: env.chromaHost,
  port: env.chromaPort,
  ssl: false,
});

let factsCollection: Collection | null = null;

export async function getFactsCollection(): Promise<Collection> {
  if (!factsCollection) {
    factsCollection = await chroma.getOrCreateCollection({
      name: FACTS_COLLECTION,
      embeddingFunction: geminiEmbeddingFunction,
    });
  }
  return factsCollection;
}
