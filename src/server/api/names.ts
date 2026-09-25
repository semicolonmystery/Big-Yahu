import { knownDisplayNames } from '../bot/identity';
import { getUsernames } from '../db/repositories/cachedMessagesRepo';

/**
 * Everyone the server can currently put a name to.
 *
 * Ids are what get stored, because they survive somebody renaming themselves,
 * and they are the one thing a person cannot read. The panel has no gateway of
 * its own to ask, so every screen that shows a person gets the name from here
 * rather than resolving ids for itself — one mechanism, which cannot drift from
 * another. An id neither Discord nor the message cache can place is left out
 * rather than named after itself, so each caller decides how its own fallback
 * reads.
 */
export function displayNames(ids: string[]): Record<string, string> {
  return { ...knownDisplayNames(ids), ...getUsernames(ids) };
}
