/**
 * Every search provider this plugin knows how to drive. The operator orders
 * them; the chain walks that order and takes the first one that answers.
 */
export const PROVIDER_IDS = ['brave', 'tavily', 'exa', 'searxng', 'duckduckgo'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface InternetConfig {
  enableSearch: boolean;
  enableFetch: boolean;
  /**
   * Which providers are tried, in order. An id nobody recognises is dropped
   * rather than failing the whole list, and a provider the operator has not
   * given a key is skipped without a word.
   */
  providerOrder: ProviderId[];
  /** The most results one search may hand back, however many a provider offers. */
  maxResults: number;
  /** How long one search may take, per provider, in milliseconds. */
  searchTimeoutMs: number;
  /** The hard byte ceiling on one fetched page. Nothing larger is read into memory. */
  fetchMaxBytes: number;
  /** Wall clock for one fetch, redirects included, in milliseconds. */
  fetchTimeoutMs: number;
  /** How many redirect hops a fetch may follow. Every hop is re-checked. */
  maxRedirects: number;
  /**
   * A reduced page at or under this many characters comes back as it is. Past
   * it, the plugin asks a model what the request was actually looking for
   * instead of pouring the whole page into the reply.
   */
  inlineCharacterLimit: number;
  /** How much reduced page text that model call is given to read. */
  extractCharacterLimit: number;
  /** The operator's own SearXNG instance, e.g. `https://searx.example.org`. */
  searxngBaseUrl: string;
}

export const DEFAULT_CONFIG: InternetConfig = {
  enableSearch: true,
  enableFetch: true,
  // Keyed providers first: each is skipped in silence until its key exists, so
  // this order costs nothing while they are unconfigured. DuckDuckGo sits last
  // because it is the one that needs no key — it is what makes the plugin do
  // something the moment it is switched on, not what should answer first once
  // an operator has paid for a real index.
  providerOrder: ['brave', 'tavily', 'exa', 'searxng', 'duckduckgo'],
  maxResults: 6,
  searchTimeoutMs: 8_000,
  // A megabyte of HTML reduces to far more text than any reply needs, and it is
  // small enough that a page which is really a video file is refused rather
  // than read.
  fetchMaxBytes: 1_500_000,
  fetchTimeoutMs: 12_000,
  maxRedirects: 4,
  inlineCharacterLimit: 4_000,
  extractCharacterLimit: 60_000,
  searxngBaseUrl: '',
};

type BooleanKey = 'enableSearch' | 'enableFetch';
type NumberKey =
  | 'maxResults'
  | 'searchTimeoutMs'
  | 'fetchMaxBytes'
  | 'fetchTimeoutMs'
  | 'maxRedirects'
  | 'inlineCharacterLimit'
  | 'extractCharacterLimit';

const NUMBER_BOUNDS: Record<NumberKey, [min: number, max: number]> = {
  maxResults: [1, 20],
  searchTimeoutMs: [1_000, 30_000],
  fetchMaxBytes: [10_000, 20_000_000],
  fetchTimeoutMs: [1_000, 60_000],
  maxRedirects: [0, 10],
  inlineCharacterLimit: [200, 40_000],
  extractCharacterLimit: [1_000, 400_000],
};

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * A saved order predates a provider added in a later version, so anything the
 * operator has not mentioned is appended in its default position rather than
 * silently dropped — otherwise shipping a new provider would quietly disable it
 * for every existing install.
 */
function providerOrder(value: unknown): ProviderId[] {
  if (!Array.isArray(value)) return [...DEFAULT_CONFIG.providerOrder];
  const chosen: ProviderId[] = [];
  for (const entry of value) {
    const id = typeof entry === 'string' ? entry.trim().toLowerCase() : entry;
    if (isProviderId(id) && !chosen.includes(id)) chosen.push(id);
  }
  if (chosen.length === 0) return [...DEFAULT_CONFIG.providerOrder];
  for (const id of DEFAULT_CONFIG.providerOrder) if (!chosen.includes(id)) chosen.push(id);
  return chosen;
}

/** Saved config predates new fields after an update, so defaults are merged every time it is read. */
export function withDefaults(config: Partial<InternetConfig>): InternetConfig {
  const boolean = (key: BooleanKey): boolean =>
    typeof config[key] === 'boolean' ? config[key] : DEFAULT_CONFIG[key];

  const whole = (key: NumberKey): number => {
    const value = config[key];
    const [min, max] = NUMBER_BOUNDS[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONFIG[key];
    return Math.min(max, Math.max(min, Math.round(value)));
  };

  return {
    enableSearch: boolean('enableSearch'),
    enableFetch: boolean('enableFetch'),
    providerOrder: providerOrder(config.providerOrder),
    maxResults: whole('maxResults'),
    searchTimeoutMs: whole('searchTimeoutMs'),
    fetchMaxBytes: whole('fetchMaxBytes'),
    fetchTimeoutMs: whole('fetchTimeoutMs'),
    maxRedirects: whole('maxRedirects'),
    inlineCharacterLimit: whole('inlineCharacterLimit'),
    extractCharacterLimit: whole('extractCharacterLimit'),
    searxngBaseUrl: typeof config.searxngBaseUrl === 'string' ? config.searxngBaseUrl.trim() : '',
  };
}
