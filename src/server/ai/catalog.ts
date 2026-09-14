import { OPENROUTER_BASE_URL } from './openrouter';

/**
 * OpenRouter's public catalog: which models exist, what they accept, and what
 * each host behind them charges.
 *
 * This is what makes capability checks data rather than a hand-kept map — a
 * model either lists `image` among its inputs or it does not — and it is where
 * DeepSeek's peak windows come from, as price overrides on its own host. The
 * catalog needs no key, so it works before one is set.
 */

const TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/** OpenRouter ids are `author/slug`; a leading `~` marks an alias. */
const MODEL_ID = /^~?[\w.:-]+\/[\w.:-]+$/;

export interface PriceOverride {
  /** Lower-case English weekday names, or null for every day. */
  days: string[] | null;
  /** UTC time as HHMM, so 100 is 01:00. Null means from midnight. */
  start: number | null;
  /** UTC time as HHMM. Null or 0 means until midnight. */
  end: number | null;
  prompt: number | null;
  completion: number | null;
  cacheRead: number | null;
}

/** Dollars per token. */
export interface Pricing {
  prompt: number | null;
  completion: number | null;
  cacheRead: number | null;
  overrides: PriceOverride[];
}

export interface CatalogModelInfo {
  id: string;
  name: string;
  /**
   * OpenRouter's own blurb. Kept only for the embedding models, where it is the
   * single place the widths a model supports are stated at all — there is no
   * structured field for them, just prose like "Matryoshka embeddings at 2048,
   * 1024, 512, and 256".
   */
  description: string;
  kind: 'chat' | 'embedding';
  inputModalities: string[];
  supportedParameters: string[];
  contextLength: number | null;
  pricing: Pricing;
}

export interface CatalogEndpointInfo {
  /** What a row pins to, such as `deepseek` or `deepinfra/fp8`. */
  tag: string;
  providerName: string;
  supportedParameters: string[];
  pricing: Pricing;
  /** OpenRouter's health flag: 0 is healthy, negative is degraded. */
  status: number | null;
}

export interface Capabilities {
  images: boolean;
  /** Both `tools` and `tool_choice`, since the reply loop sets the choice on its last turn. */
  tools: boolean;
  /** `response_format`, which is how every structured answer is asked for. */
  jsonMode: boolean;
}

const money = (value: unknown): number | null => {
  const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const whole = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

function parsePricing(raw: unknown): Pricing {
  const pricing = (raw ?? {}) as Record<string, unknown>;
  const overrides = Array.isArray(pricing.overrides) ? pricing.overrides : [];
  return {
    prompt: money(pricing.prompt),
    completion: money(pricing.completion),
    cacheRead: money(pricing.input_cache_read),
    overrides: overrides.map((entry) => {
      const override = (entry ?? {}) as Record<string, unknown>;
      return {
        days: Array.isArray(override.utc_days) ? strings(override.utc_days).map((day) => day.toLowerCase()) : null,
        start: whole(override.utc_start),
        end: whole(override.utc_end),
        prompt: money(override.prompt),
        completion: money(override.completion),
        cacheRead: money(override.input_cache_read),
      };
    }),
  };
}

function parseModel(raw: unknown, kind: CatalogModelInfo['kind']): CatalogModelInfo | null {
  const model = (raw ?? {}) as Record<string, unknown>;
  if (typeof model.id !== 'string') return null;
  const architecture = (model.architecture ?? {}) as Record<string, unknown>;
  return {
    id: model.id,
    name: typeof model.name === 'string' ? model.name : model.id,
    description: typeof model.description === 'string' ? model.description : '',
    kind,
    inputModalities: strings(architecture.input_modalities),
    supportedParameters: strings(model.supported_parameters),
    contextLength: whole(model.context_length),
    pricing: parsePricing(model.pricing),
  };
}

function parseEndpoint(raw: unknown): CatalogEndpointInfo | null {
  const endpoint = (raw ?? {}) as Record<string, unknown>;
  if (typeof endpoint.tag !== 'string') return null;
  return {
    tag: endpoint.tag,
    providerName: typeof endpoint.provider_name === 'string' ? endpoint.provider_name : endpoint.tag,
    supportedParameters: strings(endpoint.supported_parameters),
    pricing: parsePricing(endpoint.pricing),
    status: whole(endpoint.status),
  };
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${OPENROUTER_BASE_URL}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`OpenRouter ${path} answered ${response.status}`);
  return response.json();
}

const listOf = (body: unknown): unknown[] => {
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
};

interface Cached<T> {
  value: T;
  at: number;
}

let models: Cached<CatalogModelInfo[]> | null = null;
let loadingModels: Promise<CatalogModelInfo[]> | null = null;
const endpoints = new Map<string, Cached<CatalogEndpointInfo[]>>();

async function loadModels(): Promise<CatalogModelInfo[]> {
  const [chat, embedding] = await Promise.all([getJson('/models'), getJson('/embeddings/models')]);
  const value = [
    ...listOf(chat).map((raw) => parseModel(raw, 'chat')),
    ...listOf(embedding).map((raw) => parseModel(raw, 'embedding')),
  ].filter((model): model is CatalogModelInfo => model !== null);
  models = { value, at: Date.now() };
  return value;
}

/**
 * Every model OpenRouter lists, refreshed hourly. When a refresh fails the last
 * good copy is kept: a stale catalog is fine for capability checks, while no
 * catalog would block adding any model at all. Throws only when there has never
 * been one.
 */
export async function catalogModels(options: { force?: boolean } = {}): Promise<CatalogModelInfo[]> {
  if (!options.force && models && Date.now() - models.at < TTL_MS) return models.value;
  loadingModels ??= loadModels().finally(() => {
    loadingModels = null;
  });
  try {
    return await loadingModels;
  } catch (error) {
    if (models) {
      console.warn('[ai] could not refresh the OpenRouter catalog, keeping the last copy:', error);
      return models.value;
    }
    throw error;
  }
}

export async function catalogModel(id: string): Promise<CatalogModelInfo | null> {
  return (await catalogModels()).find((model) => model.id === id) ?? null;
}

/** The hosts serving one model, with their own prices and parameters. Cached per model, like the catalog. */
export async function catalogEndpoints(id: string): Promise<CatalogEndpointInfo[]> {
  if (!MODEL_ID.test(id)) return [];
  const cached = endpoints.get(id);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  try {
    const body = (await getJson(`/models/${id}/endpoints`)) as { data?: { endpoints?: unknown } };
    const list = Array.isArray(body?.data?.endpoints) ? body.data.endpoints : [];
    const value = list.map(parseEndpoint).filter((endpoint): endpoint is CatalogEndpointInfo => endpoint !== null);
    endpoints.set(id, { value, at: Date.now() });
    return value;
  } catch (error) {
    if (cached) return cached.value;
    throw error;
  }
}

/** A pin names an endpoint tag exactly, or just the provider in front of the slash. */
export function endpointFor(list: CatalogEndpointInfo[], upstream: string): CatalogEndpointInfo | undefined {
  if (!upstream) return undefined;
  return list.find((endpoint) => endpoint.tag === upstream)
    ?? list.find((endpoint) => endpoint.tag.split('/')[0] === upstream);
}

function capabilitiesFrom(model: CatalogModelInfo, parameters: string[]): Capabilities {
  return {
    images: model.inputModalities.includes('image'),
    tools: parameters.includes('tools') && parameters.includes('tool_choice'),
    jsonMode: parameters.includes('response_format'),
  };
}

/**
 * What a model can do on the host it is pinned to. The model-level parameter
 * list is the union of every host, so a pinned row is judged by its own host's
 * list whenever the catalog has one. Null when the catalog does not know the model.
 */
export async function capabilitiesOf(model: string, upstream: string): Promise<Capabilities | null> {
  const info = await catalogModel(model);
  if (!info) return null;
  if (!upstream) return capabilitiesFrom(info, info.supportedParameters);
  const endpoint = endpointFor(await catalogEndpoints(model).catch(() => []), upstream);
  return capabilitiesFrom(info, endpoint?.supportedParameters ?? info.supportedParameters);
}

/**
 * The cheapest healthy host that can do what a task needs, or '' when none can
 * be told apart. This is what a new row is pinned to, so adding a model never
 * quietly routes it somewhere dearer than it has to be.
 */
export async function cheapestEndpoint(model: string, needs: { tools: boolean; jsonMode: boolean }): Promise<string> {
  const info = await catalogModel(model);
  if (!info) return '';
  const suitable = (await catalogEndpoints(model).catch(() => []))
    .filter((endpoint) => endpoint.status === null || endpoint.status >= 0)
    .filter((endpoint) => {
      const capabilities = capabilitiesFrom(info, endpoint.supportedParameters);
      return (!needs.tools || capabilities.tools) && (!needs.jsonMode || capabilities.jsonMode);
    })
    .sort((a, b) => (a.pricing.prompt ?? Infinity) - (b.pricing.prompt ?? Infinity)
      || (a.pricing.completion ?? Infinity) - (b.pricing.completion ?? Infinity));
  return suitable[0]?.tag ?? '';
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The prices in force at a moment, after any time-of-day override. */
export function priceAt(pricing: Pricing, at: Date): Omit<Pricing, 'overrides'> {
  const day = WEEKDAYS[at.getUTCDay()];
  const time = at.getUTCHours() * 100 + at.getUTCMinutes();
  const override = pricing.overrides.find((entry) => {
    if (entry.days && !entry.days.includes(day)) return false;
    const start = entry.start ?? 0;
    const end = entry.end === null || entry.end === 0 ? 2400 : entry.end;
    return time >= start && time < end;
  });
  return {
    prompt: override?.prompt ?? pricing.prompt,
    completion: override?.completion ?? pricing.completion,
    cacheRead: override?.cacheRead ?? pricing.cacheRead,
  };
}

/** Whether a host is charging more than its base price right now, which is DeepSeek's peak. */
export function isPeak(pricing: Pricing, at: Date = new Date()): boolean {
  const now = priceAt(pricing, at).prompt;
  return now !== null && pricing.prompt !== null && now > pricing.prompt;
}

/** For tests only. */
export function resetCatalogCache(): void {
  models = null;
  loadingModels = null;
  endpoints.clear();
}
