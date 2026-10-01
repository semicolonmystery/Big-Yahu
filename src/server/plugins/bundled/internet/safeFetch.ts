import { readBoundedBody } from '../../../bot/boundedDownload';
import { assertReachableHost, type Resolver } from './addresses';

/**
 * The bot's own page fetcher.
 *
 * Deliberately not `fetch(url)` with a timeout bolted on. Three things have to
 * be true at once and only one of them is about the first URL: the scheme and
 * port have to be ones the bot will speak, the address behind the name has to
 * be one it may reach, and both have to still be true after every redirect.
 * `fetch` following redirects itself would check the first hop and then go
 * wherever it was told, which is how a public URL becomes a request to
 * 169.254.169.254.
 */

const USER_AGENT = 'BigYahu/1.0 (Discord bot; reads pages on request)';

/** Not an exhaustive list of textual types — anything `text/*` is accepted below. */
const TEXTUAL_TYPES = new Set([
  'application/xhtml+xml',
  'application/xml',
  'application/json',
  'application/ld+json',
  'application/rss+xml',
  'application/atom+xml',
  'application/javascript',
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  /** Tests hand in their own DNS; production uses the real one. */
  resolver?: Resolver;
}

export interface FetchedDocument {
  /** Where the bytes actually came from, after redirects. Attribute to this, not the asked-for URL. */
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  body: string;
  /** The hops walked, first to last, so an answer can say where it was sent. */
  redirects: string[];
}

/**
 * Scheme, credentials and port, which are properties of the URL text and can be
 * judged without asking anybody. Exported so the refusal can be tested on its
 * own, and reused unchanged at every redirect hop.
 */
export function parseFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('that is not a URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error(`refusing ${url.protocol.replace(':', '')}: pages are read over https only`);
  }
  // A URL carrying a username or password is either an attempt to send the
  // bot's identity somewhere or an attempt to reach something it should not,
  // and there is no third reason for one to arrive here.
  if (url.username || url.password) throw new Error('refusing a URL with credentials in it');
  if (url.port && url.port !== '443') {
    throw new Error(`refusing port ${url.port}: pages are read on the standard https port only`);
  }
  return url;
}

function textFrom(body: Uint8Array, contentType: string): string {
  const declared = /charset=([a-z0-9_:.+-]+)/i.exec(contentType)?.[1];
  // A page may declare any charset label it likes, including one nothing
  // implements, and the constructor is where that becomes a throw.
  const decode = (label: string): string | null => {
    try {
      return new TextDecoder(label).decode(body).replace(/^﻿/, '');
    } catch {
      return null;
    }
  };
  return (declared ? decode(declared) : null) ?? decode('utf-8') ?? '';
}

function assertTextual(contentType: string): void {
  if (!contentType) return;
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime.startsWith('text/') || TEXTUAL_TYPES.has(mime)) return;
  throw new Error(`that URL serves ${mime}, which is not a page the bot can read as text`);
}

/**
 * Fetches one page, with every guard applied at every hop.
 *
 * The timeout is created once and shared across the whole walk, so five
 * redirects each sitting just under the limit cannot add up to a request that
 * never ends — the budget is wall clock for the operation, not per request.
 */
export async function safeFetch(raw: string, options: SafeFetchOptions): Promise<FetchedDocument> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const redirects: string[] = [];
  let target = parseFetchableUrl(raw);

  for (let hop = 0; ; hop += 1) {
    await assertReachableHost(target.hostname, options.resolver);

    let response: Response;
    try {
      response = await fetch(target, {
        redirect: 'manual',
        signal,
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-language': 'en;q=0.9,*;q=0.5',
          'user-agent': USER_AGENT,
        },
      });
    } catch (error) {
      if (signal.aborted) throw new Error('that page took too long to answer');
      throw new Error(error instanceof Error ? `could not reach that page: ${error.message}` : 'could not reach that page');
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error(`that page redirected with no destination (HTTP ${response.status})`);
      if (hop >= options.maxRedirects) throw new Error(`that page redirected more than ${options.maxRedirects} times`);
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new Error('that page redirected to something that is not a URL');
      }
      // Re-parsed and re-resolved from scratch on the next turn of the loop.
      // Nothing about having arrived here legitimately carries over.
      target = parseFetchableUrl(next.toString());
      redirects.push(target.toString());
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`that page answered HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    try {
      assertTextual(contentType);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }

    // The host's own reader: it refuses an over-declared content-length before
    // allocating anything and stops mid-stream on a lying one.
    let body: Uint8Array;
    try {
      body = await readBoundedBody(response, options.maxBytes);
    } catch (error) {
      if (signal.aborted) throw new Error('that page took too long to answer');
      const message = error instanceof Error ? error.message : '';
      throw new Error(/byte limit/.test(message)
        ? `that page is bigger than the ${options.maxBytes} byte limit the operator set`
        : 'that page could not be read to the end');
    }

    return {
      finalUrl: target.toString(),
      status: response.status,
      contentType,
      bytes: body.byteLength,
      body: textFrom(body, contentType),
      redirects,
    };
  }
}
