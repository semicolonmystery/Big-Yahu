/**
 * The data shapes the plugin contract passes around.
 *
 * These live here rather than in the bot because a plugin needs them and cannot
 * reach into the bot's source. Each is pure data; the files they used to sit in
 * — the facts repository, the storage repository — carry live database handles
 * and Chroma clients that nothing outside the bot has any business importing.
 * The bot now re-exports them from here, so there is one definition.
 */

export interface FactMetadata {
  guildId: string;
  channelId: string;
  messageIds: string[];
  /** Everyone whose messages this fact came from, so facts can be filtered per person. */
  authorIds: string[];
  referencedFactIds: string[];
  timePeriodStart: number;
  timePeriodEnd: number;
  source: 'auto' | 'reply';
  createdAt: number;
}

/** Something the bot remembers, as stored. */
export interface Fact {
  id: string;
  text: string;
  metadata: FactMetadata;
}

/** A message a fact was drawn from, resolved back out of the message cache. */
export interface SourceMessage {
  messageId: string;
  channelId: string;
  guildId: string;
  authorId: string;
  authorUsername: string;
  content: string;
  messageCreatedAt: number;
  jumpLink: string;
}

/** A fact on its way in, before it has been embedded, deduped and given an id. */
export interface FactCandidate {
  text: string;
  messageIds: string[];
  authorIds?: string[];
  guildId: string;
  channelId: string;
  referencedFactIds?: string[];
  /**
   * What kind of thing this is, from the types the host defines. Several are
   * expected: nearly anything that says something is also a `message`. Leave it
   * out and the fact is untyped, which every type search still finds.
   */
  types?: string[];
  source: 'auto' | 'reply';
  timePeriodStart: number;
  timePeriodEnd: number;
}

/**
 * A plugin's own scratch space. Every call is scoped to one plugin id, which is
 * supplied by the engine and never by the plugin, so one plugin cannot read
 * another's rows.
 */
export interface PluginStorage {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  keys(): string[];
  clear(): void;
}
