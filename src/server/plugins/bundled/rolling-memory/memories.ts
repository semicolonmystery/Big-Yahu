export interface RollingMemoryConfig {
  /** How many memories may be held at once. Going over runs a compaction pass. */
  capacity: number;
  /** How many messages a new memory lives for, unless something refreshes it. */
  defaultLifespan: number;
  /** Ceiling on a lifespan the model asks for, so nothing becomes permanent by the back door. */
  maxLifespan: number;
  /** How many memories compaction leaves behind. Below capacity, or it runs again immediately. */
  compactTo: number;
}

export const DEFAULT_CONFIG: RollingMemoryConfig = {
  capacity: 30,
  // Messages, not minutes — and a channel with people in it does forty in an
  // afternoon, which had memories expiring while the conversation they described
  // was still going. Long enough to outlast a conversation, short enough that
  // what nobody comes back to still fades.
  defaultLifespan: 250,
  maxLifespan: 2000,
  compactTo: 24,
};

/**
 * A config edited by hand in the admin panel arrives as whatever somebody typed,
 * and a seeded config never picks up keys added in a later version — so every
 * read merges over the defaults and coerces, rather than trusting the object.
 */
export function withDefaults(config: Partial<RollingMemoryConfig>): RollingMemoryConfig {
  const merged = { ...DEFAULT_CONFIG, ...config };

  const whole = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };

  const capacity = whole(merged.capacity, DEFAULT_CONFIG.capacity, 1, 200);
  const maxLifespan = whole(merged.maxLifespan, DEFAULT_CONFIG.maxLifespan, 1, 5000);
  return {
    capacity,
    maxLifespan,
    defaultLifespan: Math.min(maxLifespan, whole(merged.defaultLifespan, DEFAULT_CONFIG.defaultLifespan, 1, 5000)),
    // Compacting down to the cap itself would leave it tripping on the next memory saved.
    compactTo: Math.min(capacity - 1 > 0 ? capacity - 1 : 1, whole(merged.compactTo, DEFAULT_CONFIG.compactTo, 1, 200)),
  };
}

export interface MemoryRow {
  id: number;
  text: string;
  remaining: number;
  lifespan: number;
  messageIds: string;
  /** Where it was said, so it can become a fact without a Discord message in hand. */
  guildId: string;
  /** On its way out, waiting to be asked whether any of it is worth keeping forever. */
  leaving: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryView extends MemoryRow {
  channelIds: string[];
}

/**
 * What the model is shown instead of the raw count. A number of messages left
 * means nothing without knowing the lifespan it started from, and showing both
 * invites the model to do arithmetic rather than judge.
 */
export function score(row: MemoryRow): number {
  if (row.lifespan <= 0) return 0;
  return Math.max(0, Math.min(1, row.remaining / row.lifespan));
}

/**
 * Score and staleness answer different questions and the model needs both. A
 * memory can be at 0.9 and still be irrelevant because nobody has spoken to the
 * bot for two days; one at 0.2 in a channel that has been going all morning is
 * probably still live.
 */
export function describeMemory(memory: MemoryView, now: number): string {
  const channels = memory.channelIds.map((id) => `<#${id}>`).join(' ');
  const ageMinutes = Math.max(0, Math.round((now - memory.updatedAt) / 60_000));
  const age =
    ageMinutes < 60
      ? `${ageMinutes}m ago`
      : ageMinutes < 60 * 48
        ? `${Math.round(ageMinutes / 60)}h ago`
        : `${Math.round(ageMinutes / (60 * 24))}d ago`;

  return `[memory=${memory.id}] [score ${score(memory).toFixed(2)}] [last touched ${age}]`
    + `${channels ? ` [${channels}]` : ''} ${memory.text}`;
}

/** Words worth comparing: the short ones are grammar, not content. */
function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/<[@#]!?\d+>/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((word) => word.length >= 4),
  );
}

/**
 * How much of the old memory survives in the proposed new text, 0 to 1.
 *
 * Revising is meant to be a correction — six became eight, a name was learned,
 * somebody else joined the same thread — and every one of those keeps nearly all
 * of what was there. A conversation that has drifted onto a new subject keeps
 * almost none, and rewriting the row for it destroys what the row recorded.
 *
 * Asking the model not to do that did not hold, so this measures it. Mentions
 * are dropped before comparing: who is involved is exactly what a correction
 * legitimately changes.
 */
export function survivingFraction(before: string, after: string): number {
  const old = contentWords(before);
  if (old.size === 0) return 1;
  const next = contentWords(after);
  let kept = 0;
  for (const word of old) if (next.has(word)) kept += 1;
  return kept / old.size;
}

/** Below this, it is a rewrite rather than a revision, and it is refused. */
export const MIN_SURVIVING_FRACTION = 0.5;

export function parseMessageIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
