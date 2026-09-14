import { APIError } from 'openai';

/**
 * What OpenRouter said, dug out of the error.
 *
 * The SDK keeps the inner `error` object of OpenRouter's body on `error.error`:
 * `{ code, message, metadata }`, where the HTTP status equals `code`. When an
 * upstream host refused, `metadata` names it and carries its own error verbatim;
 * when routing refused, it says why every endpoint was excluded and where that
 * is configured.
 */
export interface OpenRouterFailure {
  httpStatus: number | null;
  /** OpenRouter's own message, or the error text when it never reached OpenRouter. */
  detail: string;
  /** The upstream host, when the error came from one. */
  provider: string | null;
  /** That host's own error body, verbatim. */
  raw: string | null;
  /** Why routing excluded every endpoint. Empty when routing was not the problem. */
  blockedBy: Array<{ reason: string; configureUrl: string | null }>;
}

interface ErrorBody {
  message?: unknown;
  metadata?: {
    provider_name?: unknown;
    raw?: unknown;
    ineligibility_reasons?: Array<{ reason?: unknown; configure_url?: unknown }>;
  };
}

const text = (value: unknown): string | null =>
  typeof value === 'string' ? value : value === undefined || value === null ? null : JSON.stringify(value);

export function readOpenRouterFailure(error: unknown): OpenRouterFailure {
  if (!(error instanceof APIError)) {
    return {
      httpStatus: null,
      detail: error instanceof Error ? error.message : String(error),
      provider: null,
      raw: null,
      blockedBy: [],
    };
  }

  const body = (error.error ?? {}) as ErrorBody;
  const metadata = body.metadata ?? {};
  return {
    httpStatus: error.status ?? null,
    detail: typeof body.message === 'string' ? body.message : error.message,
    provider: typeof metadata.provider_name === 'string' ? metadata.provider_name : null,
    raw: text(metadata.raw),
    blockedBy: (metadata.ineligibility_reasons ?? [])
      .filter((entry) => typeof entry?.reason === 'string')
      .map((entry) => ({
        reason: entry.reason as string,
        configureUrl: typeof entry.configure_url === 'string' ? entry.configure_url : null,
      })),
  };
}

/**
 * What the pool should do about it.
 *
 * - `billing` — the key is out of credit. There is one key, so every model is
 *   equally dead and moving on is pure delay.
 * - `gone` — the model id does not exist, and will not in two hours either.
 * - `next-model` — this model or its host is unwell, or routing could not place
 *   it; another row may do better.
 * - `fatal` — the request or the configuration is wrong. Another model changes nothing.
 */
export type FailureKind = 'billing' | 'gone' | 'next-model' | 'fatal';

/**
 * An unknown model comes back as a 400, not a 404, so only OpenRouter's own
 * wording separates it from a malformed request. Anchored to the shapes seen:
 * "x is not a valid model ID" for chat and "Model x does not exist" for
 * embeddings, so a 400 about some other thing not existing is not mistaken for it.
 */
const MODEL_MISSING = /is not a valid model id|^model \S+ does not exist/i;

/**
 * 404 here is routing, not a missing model: every endpoint was excluded, most
 * often by the account's own privacy settings. Retiring the model for that
 * would take out a perfectly good model over a toggle. 403 is a moderation or
 * guardrail refusal at one host, which another row may not share.
 */
const TRY_ANOTHER_MODEL = new Set([403, 404, 408, 429, 500, 502, 503, 504]);

const NETWORK = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network/i;

export function classifyOpenRouterFailure(error: unknown): FailureKind {
  // The SDK's connection and timeout errors, and our own deadline firing, carry
  // no status: nothing was answered, so another attempt is worth making.
  if (error instanceof APIError && error.status === undefined) return 'next-model';
  if (!(error instanceof APIError)) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return 'next-model';
    return NETWORK.test(error instanceof Error ? error.message : String(error)) ? 'next-model' : 'fatal';
  }

  const failure = readOpenRouterFailure(error);
  if (failure.httpStatus === 402) return 'billing';
  if (failure.httpStatus === 400 && MODEL_MISSING.test(failure.detail)) return 'gone';
  if (failure.httpStatus !== null && TRY_ANOTHER_MODEL.has(failure.httpStatus)) return 'next-model';
  return 'fatal';
}

/** One line for the log: the status, OpenRouter's message, the host's own words, and any routing block. */
export function describeOpenRouterFailure(error: unknown): string {
  const failure = readOpenRouterFailure(error);
  const parts = [`${failure.httpStatus ?? 'no status'}: ${failure.detail.slice(0, 300)}`];
  if (failure.provider) {
    parts.push(`upstream ${failure.provider}${failure.raw ? ` said ${failure.raw.slice(0, 300)}` : ''}`);
  }
  for (const block of failure.blockedBy) {
    parts.push(`routing excluded it for ${block.reason}${block.configureUrl ? `, configurable at ${block.configureUrl}` : ''}`);
  }
  return parts.join(' — ');
}
