import { ChromaClient, type ChromaClientArgs, type Collection } from 'chromadb';
import { env } from '../env';
import { geminiEmbeddingFunction } from '../ai/embeddings';
import { FACTS_COLLECTION } from '@shared/constants';
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

let factsCollection: Collection | null = null;
let initializing: Promise<Collection> | null = null;

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

export async function getFactsCollection(): Promise<Collection> {
  if (factsCollection) return factsCollection;
  if (!initializing) {
    initializing = chroma.getOrCreateCollection({
      name: FACTS_COLLECTION,
      embeddingFunction: geminiEmbeddingFunction,
    }).then((collection) => {
      factsCollection = collection;
      return collection;
    }).finally(() => { initializing = null; });
  }
  return awaitInitialization(initializing);
}
