import { ApiError } from '@google/genai';

/**
 * What the API actually said, dug out of the error.
 *
 * `ApiError` carries only the HTTP number. The canonical status — `UNAVAILABLE`,
 * `RESOURCE_EXHAUSTED` — is inside the message, which the SDK sets to
 * `JSON.stringify(body)`. When the body was not JSON the SDK puts
 * `response.statusText` in the status field instead, so "Service Unavailable"
 * turns up where `UNAVAILABLE` was expected and the HTTP code is all there is.
 */
export interface ApiFailure {
  httpStatus: number | null;
  /** The canonical status string, uppercased, or null when the body carried none. */
  status: string | null;
  /** The API's own human-readable message, or the raw text when it was not JSON. */
  detail: string;
}

export function readApiFailure(error: unknown): ApiFailure {
  const httpStatus = error instanceof ApiError ? error.status : null;
  const raw = error instanceof Error ? error.message : String(error);

  try {
    const parsed = JSON.parse(raw) as { error?: { status?: unknown; message?: unknown } };
    const status = typeof parsed.error?.status === 'string' ? parsed.error.status.toUpperCase() : null;
    const detail = typeof parsed.error?.message === 'string' ? parsed.error.message : raw;
    // "SERVICE UNAVAILABLE" is a reason phrase, not a canonical status.
    return { httpStatus, status: status && /^[A-Z_]+$/.test(status) ? status : null, detail };
  } catch {
    return { httpStatus, status: null, detail: raw };
  }
}

/**
 * What the pool should do about it.
 *
 * - `billing` — the key cannot pay. Every model behind it is equally dead, so
 *   moving to the next one is pure delay, and the model that answered is not at
 *   fault and must not be rested for it.
 * - `next-model` — this model is unwell; another may not be.
 * - `fatal` — the request or the configuration is wrong. Trying again with
 *   different models changes nothing.
 */
export type FailureKind = 'billing' | 'gone' | 'next-model' | 'fatal';

/**
 * The model does not exist as far as the API is concerned — withdrawn, renamed,
 * or never real. Distinct from `next-model` because a rest period is the wrong
 * remedy: it will not exist in two hours either, so it is retired rather than
 * rested, and only the operator brings it back.
 */
function isGone(failure: ApiFailure): boolean {
  if (failure.status === 'MODEL_NOT_FOUND') return true;
  // 404 NOT_FOUND against generateContent can only be the model in the path.
  return failure.status === 'NOT_FOUND' || (failure.status === null && failure.httpStatus === 404);
}

/**
 * `RESOURCE_EXHAUSTED` is the one status that means two unrelated things, and it
 * is identical in both: the prepay balance is gone, or the per-minute rate limit
 * was brushed. The first is terminal for every model at once; the second is
 * routine on the free tier, where ~15 requests a minute against a reply costing
 * three or more calls means the next model in the pool is usually the answer.
 *
 * Only the wording separates them, so the wording is what this reads — and it
 * looks for the terminal case specifically. Anything unrecognised falls through
 * to the ordinary rate-limit path, because being wrong there costs one wasted
 * model attempt, while being wrong the other way stops the bot dead.
 */
const BILLING_WORDING = /prepayment|credit|billing|payment|purchase|free tier is not available|plan/i;

/** 400 with billing not enabled at all — the same dead end, under a different status. */
function isBillingFailure(failure: ApiFailure): boolean {
  if (failure.status === 'RESOURCE_EXHAUSTED' || failure.httpStatus === 429) {
    return BILLING_WORDING.test(failure.detail);
  }
  if (failure.status === 'FAILED_PRECONDITION') return BILLING_WORDING.test(failure.detail);
  return false;
}

/** Statuses where another model in the pool is worth trying. */
const TRY_ANOTHER_MODEL = new Set([
  'UNAVAILABLE',
  'INTERNAL',
  'DEADLINE_EXCEEDED',
  'ABORTED',
  'RESOURCE_EXHAUSTED',
]);

const TRY_ANOTHER_HTTP = new Set([429, 500, 502, 503, 504]);

export function classifyFailure(error: unknown): FailureKind {
  // Not the API at all: a socket closed, DNS, a client-side timeout. Another
  // model goes over the same wire, but it is worth one attempt.
  if (!(error instanceof ApiError)) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return 'next-model';
    const text = error instanceof Error ? error.message : String(error);
    return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network/i.test(text)
      ? 'next-model'
      : 'fatal';
  }

  const failure = readApiFailure(error);
  if (isBillingFailure(failure)) return 'billing';
  if (isGone(failure)) return 'gone';
  if (failure.status && TRY_ANOTHER_MODEL.has(failure.status)) return 'next-model';
  if (!failure.status && failure.httpStatus !== null && TRY_ANOTHER_HTTP.has(failure.httpStatus)) {
    return 'next-model';
  }
  return 'fatal';
}

/** One line naming the model, the status and what was done about it. */
export function describeFailure(error: unknown): string {
  const failure = readApiFailure(error);
  const code = failure.httpStatus === null ? '' : `${failure.httpStatus} `;
  return `${code}${failure.status ?? 'no status'}: ${failure.detail.slice(0, 300)}`;
}
