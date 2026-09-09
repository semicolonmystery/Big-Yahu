import { discordClient } from './client';

/**
 * Display names for ids the message cache cannot resolve.
 *
 * The bot never caches its own messages, so its own id is never in
 * `cached_messages` and a fact mentioning the bot rendered as a raw
 * `<@id>` in the admin panel — which reads as the feature being broken
 * rather than as the bot. Anyone the gateway happens to know is filled in
 * too. Returns nothing when the gateway is down, since panels have to work
 * with no Discord connection at all.
 */
export function knownDisplayNames(ids: string[]): Record<string, string> {
  const names: Record<string, string> = {};
  const self = discordClient.user;

  for (const id of new Set(ids)) {
    if (self && id === self.id) {
      names[id] = self.displayName || self.username;
      continue;
    }
    const user = discordClient.users.cache.get(id);
    if (user) names[id] = user.displayName || user.username;
  }

  return names;
}
