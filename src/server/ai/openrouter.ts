import OpenAI from 'openai';
import { env } from '../env';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** A single request's ceiling, matching the one `claimAIRequest` hands out. */
const REQUEST_TIMEOUT_MS = 45_000;

let client: OpenAI | null = null;

/**
 * Where a request may go. A pinned row goes only to its own host, with no
 * fallback to the others: they charge more and do not share its cache. Either
 * way, `require_parameters` keeps a request off any host that would quietly
 * ignore JSON mode or tools instead of honouring them.
 */
export function routingFor(upstream: string): { order?: string[]; allow_fallbacks?: boolean; require_parameters: boolean } {
  return upstream
    ? { order: [upstream], allow_fallbacks: false, require_parameters: true }
    : { require_parameters: true };
}

/**
 * The one client every model call goes through, chat and embeddings alike.
 *
 * Built on first use rather than at import, so the admin panel and the test
 * suite run without a key. Retries belong to the model pool, not the SDK: its
 * own automatic retries would hit the same model again behind the pool's back,
 * and its ten-minute default timeout is longer than a whole reply may take.
 */
export function openrouter(): OpenAI {
  if (client) return client;
  if (!env.openrouterApiKey) throw new Error('OPENROUTER_API_KEY is not set');
  client = new OpenAI({
    apiKey: env.openrouterApiKey,
    baseURL: OPENROUTER_BASE_URL,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return client;
}
