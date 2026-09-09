import dotenv from 'dotenv';

dotenv.config();

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export const env = {
  discordToken: optional('DISCORD_TOKEN'),
  discordGuildId: optional('DISCORD_GUILD_ID'),
  geminiApiKey: optional('GEMINI_API_KEY'),
  chromaHost: process.env.CHROMA_HOST ?? 'localhost',
  chromaPort: Number(process.env.CHROMA_PORT ?? 8000),
  sqlitePath: process.env.SQLITE_PATH ?? './data/big-yahu.sqlite3',
  port: Number(process.env.PORT ?? 3000),
  isProduction: process.env.NODE_ENV === 'production',
  /**
   * How many reverse proxies sit in front of this instance. 0 means none, which
   * is what `docker compose up` gives you.
   *
   * It is a count rather than a boolean because `X-Forwarded-For` is a list the
   * client can prepend to. Telling Express to trust the whole header lets anyone
   * claim any address; telling it exactly how many hops are yours makes it count
   * that many from the right, past anything the caller wrote. Set it to 1 behind
   * a single nginx, 2 behind nginx behind Cloudflare, and so on.
   */
  trustedProxyHops: Math.max(0, Math.trunc(Number(process.env.TRUSTED_PROXY_HOPS ?? 0)) || 0),
};

/**
 * With DISCORD_GUILD_ID set, this instance serves that guild only and ignores
 * every other one — so several instances can share a bot account, each doing
 * no work for guilds that are not theirs.
 */
export function isServedGuild(guildId: string | null): boolean {
  if (!env.discordGuildId) return true;
  return guildId === env.discordGuildId;
}
