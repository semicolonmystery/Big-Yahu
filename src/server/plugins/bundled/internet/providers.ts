import { readBoundedBody } from '../../../bot/boundedDownload';
import type { InternetConfig, ProviderId } from './config';

/**
 * Search, behind one interface, with five implementations and an order the
 * operator sets.
 *
 * The point of the chain is that the bot keeps working as the operator's setup
 * changes underneath it. A provider with no key is not an error, it is a
 * provider that is not set up, so it is skipped without a word. A provider that
 * errors, rate-limits or simply has nothing is not the end of the search, it is
 * a reason to ask the next one. Only when the whole order is exhausted does the
 * tool say so — and then it says which ones it tried and what each did, because
 * "search failed" leaves an operator with nowhere to look.
 *
 * Every response is parsed defensively. These are five external APIs that can
 * each rename a field in a release nobody told us about; a missing `description`
 * should cost a snippet, not the search.
 */

/** Provider JSON is small by nature. A provider sending megabytes is a provider misbehaving. */
const PROVIDER_BYTE_CAP = 4 * 1024 * 1024;

export interface SearchRequest {
  query: string;
  limit: number;
  recencyDays?: number;
  /** A bare host, e.g. `nodejs.org`. Passed natively where a provider supports it. */
  site?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface ProviderDeps {
  env: Record<string, string>;
  config: InternetConfig;
}

export interface SearchProvider {
  id: ProviderId;
  label: string;
  /** What the operator has to fill in. Named in the exhausted-chain error, never its value. */
  requires: string;
  /** False while the operator has not set it up. The chain then skips it silently. */
  configured(deps: ProviderDeps): boolean;
  search(request: SearchRequest, deps: ProviderDeps): Promise<SearchHit[]>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A result is only usable if it has somewhere to point. Anything else is dropped. */
function asHttpUrl(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Dates come back in every shape these five APIs can think of: ISO, RFC 1123,
 * a bare year, and Brave's "3 days ago". An ISO day is produced where the string
 * parses as a date and the original is kept where it does not, because "3 days
 * ago" is still worth more to a reader than nothing.
 */
function asPublishedAt(value: unknown): string | undefined {
  const text = asText(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return text.slice(0, 60);
}

function hit(title: unknown, url: unknown, snippet: unknown, publishedAt?: unknown): SearchHit | null {
  const href = asHttpUrl(url);
  if (!href) return null;
  const published = asPublishedAt(publishedAt);
  return {
    title: asText(title).slice(0, 300) || href,
    url: href,
    snippet: asText(snippet).slice(0, 1_200),
    ...(published ? { publishedAt: published } : {}),
  };
}

interface JsonRequest {
  url: string | URL;
  label: string;
  timeoutMs: number;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * One request to one provider. Failures carry the status and nothing else: a
 * provider's error body can quote the request back, and a request carrying a key
 * in a header is one careless `${body}` away from that key reaching the model.
 */
async function requestJson(request: JsonRequest): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method ?? 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(request.timeoutMs),
      headers: {
        accept: 'application/json',
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
  } catch {
    throw new Error(`${request.label} could not be reached`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const hint = response.status === 401 || response.status === 403
      ? ' — check the key or the instance settings'
      : response.status === 429 ? ' — rate limited' : '';
    throw new Error(`${request.label} answered HTTP ${response.status}${hint}`);
  }
  const body = await readBoundedBody(response, PROVIDER_BYTE_CAP);
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(body)) as unknown;
  } catch {
    throw new Error(`${request.label} did not answer with JSON`);
  }
}

/** `site:` is understood by every real web index, so it goes in the query where there is no native field. */
function withSiteOperator(query: string, site?: string): string {
  return site ? `${query} site:${site}` : query;
}

// ---------------------------------------------------------------------------
// Brave Search
// GET https://api.search.brave.com/res/v1/web/search, key in X-Subscription-Token.
// Results arrive as web.results[] carrying title, url, description, and a date
// in page_age (ISO-ish) or age (a human phrase); both are optional.
// ---------------------------------------------------------------------------
const brave: SearchProvider = {
  id: 'brave',
  label: 'Brave Search',
  requires: 'BRAVE_API_KEY',
  configured: ({ env }) => Boolean(env.BRAVE_API_KEY?.trim()),

  async search(request, deps) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', withSiteOperator(request.query, request.site));
    // Brave caps count at 20 and the plugin caps it lower still.
    url.searchParams.set('count', String(Math.min(20, request.limit)));
    url.searchParams.set('safesearch', 'moderate');
    const freshness = request.recencyDays === undefined ? undefined
      : request.recencyDays <= 1 ? 'pd'
        : request.recencyDays <= 7 ? 'pw'
          : request.recencyDays <= 31 ? 'pm'
            : request.recencyDays <= 366 ? 'py' : undefined;
    if (freshness) url.searchParams.set('freshness', freshness);

    const body = asRecord(await requestJson({
      url,
      label: 'Brave Search',
      timeoutMs: deps.config.searchTimeoutMs,
      headers: {
        'accept-encoding': 'gzip',
        'x-subscription-token': deps.env.BRAVE_API_KEY.trim(),
      },
    }));
    return asArray(asRecord(body.web).results)
      .map((entry) => {
        const result = asRecord(entry);
        return hit(result.title, result.url, result.description, result.page_age ?? result.age);
      })
      .filter((entry): entry is SearchHit => entry !== null);
  },
};

// ---------------------------------------------------------------------------
// Tavily
// POST https://api.tavily.com/search, key as an Authorization bearer token.
// results[] carry title, url, content and — only when asked for with
// include_published_date — published_date.
// ---------------------------------------------------------------------------
const tavily: SearchProvider = {
  id: 'tavily',
  label: 'Tavily',
  requires: 'TAVILY_API_KEY',
  configured: ({ env }) => Boolean(env.TAVILY_API_KEY?.trim()),

  async search(request, deps) {
    const timeRange = request.recencyDays === undefined ? undefined
      : request.recencyDays <= 1 ? 'day'
        : request.recencyDays <= 7 ? 'week'
          : request.recencyDays <= 31 ? 'month' : 'year';

    const body = asRecord(await requestJson({
      url: 'https://api.tavily.com/search',
      label: 'Tavily',
      method: 'POST',
      timeoutMs: deps.config.searchTimeoutMs,
      headers: { authorization: `Bearer ${deps.env.TAVILY_API_KEY.trim()}` },
      body: {
        query: request.query,
        max_results: Math.min(20, request.limit),
        search_depth: 'basic',
        topic: 'general',
        include_published_date: true,
        ...(timeRange ? { time_range: timeRange } : {}),
        ...(request.site ? { include_domains: [request.site] } : {}),
      },
    }));
    return asArray(body.results)
      .map((entry) => {
        const result = asRecord(entry);
        return hit(result.title, result.url, result.content, result.published_date);
      })
      .filter((entry): entry is SearchHit => entry !== null);
  },
};

// ---------------------------------------------------------------------------
// Exa
// POST https://api.exa.ai/search, key in x-api-key. results[] carry id, title,
// url, publishedDate, author, and whatever `contents` asked for — a snippet only
// exists because text is requested, so a little of it is.
// ---------------------------------------------------------------------------
const exa: SearchProvider = {
  id: 'exa',
  label: 'Exa',
  requires: 'EXA_API_KEY',
  configured: ({ env }) => Boolean(env.EXA_API_KEY?.trim()),

  async search(request, deps) {
    const startPublishedDate = request.recencyDays === undefined
      ? undefined
      : new Date(Date.now() - request.recencyDays * 86_400_000).toISOString();

    const body = asRecord(await requestJson({
      url: 'https://api.exa.ai/search',
      label: 'Exa',
      method: 'POST',
      timeoutMs: deps.config.searchTimeoutMs,
      headers: { 'x-api-key': deps.env.EXA_API_KEY.trim() },
      body: {
        query: request.query,
        numResults: Math.min(100, request.limit),
        type: 'auto',
        contents: { text: { maxCharacters: 600 } },
        ...(startPublishedDate ? { startPublishedDate } : {}),
        ...(request.site ? { includeDomains: [request.site] } : {}),
      },
    }));
    return asArray(body.results)
      .map((entry) => {
        const result = asRecord(entry);
        const highlights = asArray(result.highlights).filter((part): part is string => typeof part === 'string');
        const snippet = highlights.length > 0 ? highlights.join(' … ') : (result.summary ?? result.text);
        return hit(result.title, result.url, snippet, result.publishedDate);
      })
      .filter((entry): entry is SearchHit => entry !== null);
  },
};

// ---------------------------------------------------------------------------
// SearXNG
// The operator's own instance, so the base URL is ordinary configuration rather
// than a secret, and it is not put through the plugin's SSRF guard: a
// self-hosted instance normally *is* on the private network the guard exists to
// keep the model away from, and this URL is the operator's own choice, never
// something a model can write.
//
// GET <base>/search?q=…&format=json. The JSON format has to be switched on in
// the instance's settings.yml, which is what a 403 here almost always means.
// results[] carry url, title, content, publishedDate and engine.
// ---------------------------------------------------------------------------
const searxng: SearchProvider = {
  id: 'searxng',
  label: 'SearXNG',
  requires: 'SearXNG instance URL',
  configured: ({ config }) => Boolean(config.searxngBaseUrl.trim()),

  async search(request, deps) {
    let base: URL;
    try {
      base = new URL(deps.config.searxngBaseUrl.trim());
    } catch {
      throw new Error('the configured SearXNG instance URL is not a URL');
    }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') {
      throw new Error('the configured SearXNG instance URL must be http or https');
    }
    // Joined onto the configured path so an instance served under a sub-path works.
    const url = new URL('search', base.href.endsWith('/') ? base.href : `${base.href}/`);
    url.searchParams.set('q', withSiteOperator(request.query, request.site));
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '1');
    url.searchParams.set('pageno', '1');
    // The documented values are day, month and year. Many instances also accept
    // "week", but it is not in the API documentation, so it is not relied on.
    const timeRange = request.recencyDays === undefined ? undefined
      : request.recencyDays <= 1 ? 'day'
        : request.recencyDays <= 31 ? 'month' : 'year';
    if (timeRange) url.searchParams.set('time_range', timeRange);

    const body = asRecord(await requestJson({
      url,
      label: 'SearXNG',
      timeoutMs: deps.config.searchTimeoutMs,
    }));
    return asArray(body.results)
      .map((entry) => {
        const result = asRecord(entry);
        return hit(result.title, result.url, result.content, result.publishedDate);
      })
      .filter((entry): entry is SearchHit => entry !== null);
  },
};

// ---------------------------------------------------------------------------
// DuckDuckGo
//
// Be clear about what this is, because the name promises more than the endpoint
// delivers. DuckDuckGo publishes no API over its web index. What it publishes is
// the Instant Answer API at api.duckduckgo.com — the zero-click box above the
// results, built from curated sources such as Wikipedia. For an entity ("python
// programming language") it returns a solid abstract with a link. For an
// ordinary query ("typescript release notes") it returns an object with every
// field empty, and this provider then reports no results and the chain moves on.
//
// The html.duckduckgo.com and lite.duckduckgo.com endpoints do carry real web
// results, and scraping them is deliberately not done here: from a server they
// answer with an anti-bot challenge rather than results, so the code would be
// both against the spirit of their terms and unreliable in exactly the way a
// fallback must not be.
//
// So this is the floor, not the plan: it needs no key, which means the plugin
// does something the moment it is switched on, and it is last in the default
// order because any configured provider is better.
// ---------------------------------------------------------------------------
const duckduckgo: SearchProvider = {
  id: 'duckduckgo',
  label: 'DuckDuckGo Instant Answer',
  requires: 'nothing — it needs no key',
  configured: () => true,

  async search(request, deps) {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', withSiteOperator(request.query, request.site));
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('no_redirect', '1');
    url.searchParams.set('skip_disambig', '1');
    // Their documented courtesy: identify the caller.
    url.searchParams.set('t', 'big-yahu');

    const body = asRecord(await requestJson({
      url,
      label: 'DuckDuckGo',
      timeoutMs: deps.config.searchTimeoutMs,
    }));

    const hits: SearchHit[] = [];
    const push = (entry: SearchHit | null): void => { if (entry) hits.push(entry); };

    push(hit(body.Heading, body.AbstractURL, body.AbstractText));
    push(hit(body.Heading, body.DefinitionURL, body.Definition));
    for (const entry of asArray(body.Results)) {
      const result = asRecord(entry);
      push(hit(result.Text, result.FirstURL, result.Text));
    }
    // RelatedTopics is either a flat list of topics or a list of named groups
    // each holding its own Topics array, depending on the query.
    for (const entry of asArray(body.RelatedTopics)) {
      const topic = asRecord(entry);
      const nested = asArray(topic.Topics);
      if (nested.length > 0) {
        for (const inner of nested) {
          const child = asRecord(inner);
          push(hit(child.Text, child.FirstURL, child.Text));
        }
        continue;
      }
      push(hit(topic.Text, topic.FirstURL, topic.Text));
    }
    return hits;
  },
};

const PROVIDERS: Record<ProviderId, SearchProvider> = { brave, tavily, exa, searxng, duckduckgo };

export function providerLabel(id: ProviderId): string {
  return PROVIDERS[id].label;
}

export interface ProviderAttempt {
  provider: ProviderId;
  outcome: string;
}

export interface ChainResult {
  hits: SearchHit[];
  /** Which provider answered, or null when none did. */
  provider: ProviderId | null;
  attempts: ProviderAttempt[];
}

function normaliseForDedupe(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
  } catch {
    return url;
  }
}

function tidy(hits: SearchHit[], request: SearchRequest): SearchHit[] {
  const seen = new Set<string>();
  const kept: SearchHit[] = [];
  for (const entry of hits) {
    // A provider with no native domain filter still has to honour the ask, and
    // one with a native filter is checked rather than trusted.
    if (request.site) {
      const host = (() => { try { return new URL(entry.url).hostname.toLowerCase(); } catch { return ''; } })();
      const wanted = request.site.toLowerCase();
      if (host !== wanted && !host.endsWith(`.${wanted}`)) continue;
    }
    const key = normaliseForDedupe(entry.url);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
    if (kept.length >= request.limit) break;
  }
  return kept;
}

/** Walks the operator's order and returns the first real answer, with a record of what it took. */
export async function searchWithChain(request: SearchRequest, deps: ProviderDeps): Promise<ChainResult> {
  const attempts: ProviderAttempt[] = [];

  for (const id of deps.config.providerOrder) {
    const provider = PROVIDERS[id];
    if (!provider) continue;

    if (!provider.configured(deps)) {
      attempts.push({ provider: id, outcome: `not set up (needs ${provider.requires})` });
      continue;
    }
    try {
      const hits = tidy(await provider.search(request, deps), request);
      if (hits.length === 0) {
        attempts.push({ provider: id, outcome: 'answered with nothing' });
        continue;
      }
      attempts.push({ provider: id, outcome: `answered with ${hits.length} result(s)` });
      return { hits, provider: id, attempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed';
      // The message is built from status codes and fixed strings, never from a
      // request that carries a key.
      console.error(`[internet] ${id} search failed: ${message}`);
      attempts.push({ provider: id, outcome: `failed: ${message}` });
    }
  }

  return { hits: [], provider: null, attempts };
}
