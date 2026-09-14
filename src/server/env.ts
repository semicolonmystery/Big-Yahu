import dotenv from 'dotenv';

dotenv.config();

/** Validate before opening databases, listening, or connecting to Discord. */
export function parseEnvironment(values: NodeJS.ProcessEnv) {
  const optional = (name: string): string | undefined => values[name]?.trim() || undefined;
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = optional(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
  };
  const discordToken = optional('DISCORD_TOKEN');
  const discordGuildId = optional('DISCORD_GUILD_ID');
  const openrouterApiKey = optional('OPENROUTER_API_KEY');
  if (discordGuildId && (!/^[1-9]\d{16,19}$/.test(discordGuildId) || BigInt(discordGuildId) > 18446744073709551615n)) {
    throw new Error('DISCORD_GUILD_ID must be a valid Discord server ID');
  }
  if (discordToken && !discordGuildId) {
    throw new Error('DISCORD_GUILD_ID is required when DISCORD_TOKEN is set; this bot serves one server only');
  }
  if (discordToken && !openrouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required when DISCORD_TOKEN is set');
  }
  return {
    discordToken,
    discordGuildId,
    openrouterApiKey,
    chromaHost: optional('CHROMA_HOST') ?? 'localhost',
    chromaPort: integer('CHROMA_PORT', 8000, 1, 65535),
    sqlitePath: optional('SQLITE_PATH') ?? './data/big-yahu.sqlite3',
    port: integer('PORT', 3000, 1, 65535),
    isProduction: values.NODE_ENV === 'production',
    // Exact proxy hop count, never blanket trust of client-supplied forwarding headers.
    trustedProxyHops: integer('TRUSTED_PROXY_HOPS', 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

export const env = parseEnvironment(process.env);

/** Missing configuration is closed, including in admin-only mode. */
export function isServedGuild(guildId: string | null): boolean {
  return Boolean(env.discordGuildId) && guildId === env.discordGuildId;
}
