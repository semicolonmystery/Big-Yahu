import { bundlesFor, sealBundles } from '../db/repositories/messageBundlesRepo';
import { messagesMaterial } from './material';
import type { WindowMessage } from './context';

/**
 * Splitting a channel's history into the part that repeats and the part that
 * does not.
 *
 * A provider caches the front of a request, so a cache hit needs the request to
 * begin with exactly what an earlier one began with. The window never does that
 * on its own: every new message shifts everything behind it by one, and the
 * bytes are different from the first character. Cutting the history at points
 * that never move gives whole runs of messages that are identical call after
 * call.
 *
 * The trade is that a bundle is sent whole. Needing one message out of five
 * costs all five — but they are five cached tokens against one uncached run
 * that would have cost the lot anyway.
 */

export interface BundledWindow {
  /** Sent ahead of the material, oldest first, and identical from call to call. */
  bundles: Array<Record<string, unknown>>;
  /** Everything not in a sealed bundle. This is what changes between calls. */
  loose: WindowMessage[];
}

/**
 * Bundling is only ever applied to plain history. A quoted message, a message
 * somebody replied to, anything the reply singles out — those are pulled in
 * because of this one conversation and would drag unrelated history along with
 * them, so they stay where they are.
 */
export function bundleWindow(
  channelId: string,
  window: WindowMessage[],
  options: { enabled: boolean; size: number },
): BundledWindow {
  if (!options.enabled || options.size < 2 || window.length === 0) return { bundles: [], loose: window };

  // Seal whatever this window completes. Called on every reply, which is what
  // keeps the cuts moving forward as a channel talks.
  sealBundles(channelId, window.map((message) => message.id), options.size);

  const byId = new Map(window.map((message) => [message.id, message]));
  const bundles: Array<Record<string, unknown>> = [];
  const bundled = new Set<string>();

  for (const bundle of bundlesFor(channelId)) {
    const present = bundle.messageIds.map((id) => byId.get(id)).filter((message) => message !== undefined);
    // A bundle nothing in the window needs is not worth sending; one the window
    // only partly covers is sent for the part that is there, since the rest has
    // aged out of what was fetched.
    if (present.length === 0) continue;
    for (const message of present) bundled.add(message.id);
    bundles.push({ earlierMessages: messagesMaterial(present) });
  }

  return { bundles, loose: window.filter((message) => !bundled.has(message.id)) };
}
