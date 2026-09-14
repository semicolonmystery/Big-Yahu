import { ChromaClient, type ChromaClientArgs, type Collection } from 'chromadb';
import { env } from '../env';
import { activeEmbedding, embeddingFunctionFor, type EmbeddingConfig } from '../ai/embeddings';
import { getAIRequestSignal } from '../ai/requestBudget';

const REQUEST_TIMEOUT_MS = 10_000;

interface SDKTransport {
  getConfig(): { fetch?: typeof fetch };
  setConfig(config: { fetch: typeof fetch }): unknown;
}

/**
 * Chroma 3.5 accepts only a static fetchOptions.signal and overwrites a supplied
 * fetch implementation. A signal created with the singleton would expire once
 * and then poison every subsequent call. Its internal HTTP client is the one
 * narrow compatibility adapter here: retain Chroma's configured error-mapping
 * fetch and add a fresh deadline for each real request, including body reads.
 * Tests use the installed SDK, so a library upgrade cannot silently drop this.
 */
export function createBoundedChromaClient(
  options: Partial<ChromaClientArgs>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): ChromaClient {
  const client = new ChromaClient(options);
  const internal: unknown = Reflect.get(client, 'apiClient');
  if (!internal || typeof internal !== 'object'
    || typeof Reflect.get(internal, 'getConfig') !== 'function'
    || typeof Reflect.get(internal, 'setConfig') !== 'function') {
    throw new Error('Unsupported Chroma SDK HTTP client: update the bounded transport adapter before starting');
  }
  const transport = internal as SDKTransport;
  const configuredFetch = transport.getConfig().fetch;
  if (typeof configuredFetch !== 'function') {
    throw new Error('Unsupported Chroma SDK HTTP client: configured fetch is missing');
  }
  transport.setConfig({
    fetch: async (input, init) => {
      const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const outer = getAIRequestSignal();
      const signal = AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...(inherited ? [inherited] : []),
        ...(outer ? [outer] : []),
      ]);
      signal.throwIfAborted();
      try {
        return await configuredFetch(input, { ...init, signal });
      } catch (error) {
        // The SDK maps fetch aborts to a connection error. Keep the actual
        // cancellation reason, while retaining its normal HTTP error classes.
        signal.throwIfAborted();
        throw error;
      }
    },
  });
  return client;
}

export const chroma = createBoundedChromaClient({
  host: env.chromaHost,
  port: env.chromaPort,
  ssl: false,
});

/**
 * One collection per embedding pair, named after it.
 *
 * A collection is fixed to the width of the vectors in it, and mixing two models
 * in one is not a degraded search but a meaningless one, so changing either
 * builds a new collection beside the old rather than writing into it.
 */
export function collectionNameFor(config: EmbeddingConfig): string {
  return `facts__${config.model.replace(/[^\w.-]+/g, '_')}__${config.dimensions}`;
}

const collections = new Map<string, Promise<Collection>>();

function awaitInitialization(pending: Promise<Collection>): Promise<Collection> {
  const signal = getAIRequestSignal();
  if (!signal) return pending;
  signal.throwIfAborted();
  // A cancelled waiter must not cancel a shared request owned by another reply.
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** The collection for one embedding pair, created on first use with that pair recorded on it. */
export function collectionFor(config: EmbeddingConfig): Promise<Collection> {
  const name = collectionNameFor(config);
  let pending = collections.get(name);
  if (!pending) {
    pending = chroma
      .getOrCreateCollection({
        name,
        embeddingFunction: embeddingFunctionFor(config),
        // Written down so a mismatch is something that can be noticed rather
        // than guessed at from the name.
        metadata: { embeddingModel: config.model, dimensions: config.dimensions },
      })
      .catch((error: unknown) => {
        collections.delete(name);
        throw error;
      });
    collections.set(name, pending);
  }
  return awaitInitialization(pending);
}

/** What recall searches: the pair the live collection was built with, not necessarily today's setting. */
export function getFactsCollection(): Promise<Collection> {
  return collectionFor(activeEmbedding());
}

/** After a swap, so the next call opens the collection that is now live. */
export function forgetCollections(): void {
  collections.clear();
}
