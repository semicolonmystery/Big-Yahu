import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/server/db/client';
import { messageBundles } from '../../src/server/db/schema';
import {
  bundleCount, bundlesFor, clearBundles, sealBundles,
} from '../../src/server/db/repositories/messageBundlesRepo';
import { bundleWindow } from '../../src/server/ai/bundling';
import type { WindowMessage } from '../../src/server/ai/context';

const CHANNEL = 'channel-1';

const message = (id: string): WindowMessage => ({
  id, authorId: 'u1', authorUsername: 'Alice', displayName: 'Alice', content: `message ${id}`,
  createdAt: Number(id), isSelf: false,
});

const window = (count: number, from = 1): WindowMessage[] =>
  Array.from({ length: count }, (_, index) => message(String(from + index)));

beforeEach(() => { db.delete(messageBundles).run(); });

describe('cutting history into bundles', () => {
  // A short bundle would have to grow when the next message arrives, and growing
  // is the one thing a bundle must never do: its bytes would change and every
  // request built on it would miss.
  it('seals nothing until a bundle can be filled exactly', () => {
    expect(sealBundles(CHANNEL, ['1', '2', '3', '4'], 5)).toBe(0);
    expect(bundleCount()).toBe(0);

    expect(sealBundles(CHANNEL, ['1', '2', '3', '4', '5'], 5)).toBe(1);
    expect(bundlesFor(CHANNEL)[0].messageIds).toEqual(['1', '2', '3', '4', '5']);
  });

  it('leaves the remainder loose rather than padding a bundle out', () => {
    sealBundles(CHANNEL, ['1', '2', '3', '4', '5', '6', '7'], 5);
    expect(bundlesFor(CHANNEL)).toHaveLength(1);
    expect(bundlesFor(CHANNEL)[0].messageIds).toEqual(['1', '2', '3', '4', '5']);
  });

  it('seals several at once when the history allows it', () => {
    expect(sealBundles(CHANNEL, ['1', '2', '3', '4', '5', '6'], 2)).toBe(3);
    expect(bundlesFor(CHANNEL).map((bundle) => bundle.messageIds)).toEqual([['1', '2'], ['3', '4'], ['5', '6']]);
  });

  // Called on every reply with an overlapping window, so the cuts have to stay
  // where they were rather than being redrawn around whatever was fetched.
  it('never re-cuts what is already bundled', () => {
    sealBundles(CHANNEL, ['1', '2', '3', '4'], 2);
    sealBundles(CHANNEL, ['1', '2', '3', '4', '5', '6'], 2);
    expect(bundlesFor(CHANNEL).map((bundle) => bundle.messageIds)).toEqual([['1', '2'], ['3', '4'], ['5', '6']]);
  });

  it('keeps channels apart', () => {
    sealBundles(CHANNEL, ['1', '2'], 2);
    sealBundles('channel-2', ['9', '8'], 2);
    expect(bundlesFor(CHANNEL).map((bundle) => bundle.messageIds)).toEqual([['1', '2']]);
    expect(bundlesFor('channel-2').map((bundle) => bundle.messageIds)).toEqual([['9', '8']]);
  });

  it('refuses a size that cannot bundle anything', () => {
    expect(sealBundles(CHANNEL, ['1', '2', '3'], 1)).toBe(0);
    expect(bundleCount()).toBe(0);
  });

  it('throws every bundle away when asked', () => {
    sealBundles(CHANNEL, ['1', '2', '3', '4'], 2);
    clearBundles();
    expect(bundleCount()).toBe(0);
  });
});

describe('what actually goes in the request', () => {
  it('sends nothing bundled while it is switched off', () => {
    const result = bundleWindow(CHANNEL, window(10), { enabled: false, size: 5 });
    expect(result.bundles).toEqual([]);
    expect(result.loose).toHaveLength(10);
    // And nothing is cut either, so switching it on later starts clean.
    expect(bundleCount()).toBe(0);
  });

  it('puts sealed history in bundles and leaves the tail loose', () => {
    const result = bundleWindow(CHANNEL, window(12), { enabled: true, size: 5 });
    expect(result.bundles).toHaveLength(2);
    // Twelve messages, two bundles of five, two still loose.
    expect(result.loose.map((entry) => entry.id)).toEqual(['11', '12']);
  });

  // The whole point: the same run of messages is the same bytes next time, even
  // though the window has moved on.
  it('produces an identical leading bundle on the next call', () => {
    const first = bundleWindow(CHANNEL, window(12), { enabled: true, size: 5 });
    const second = bundleWindow(CHANNEL, window(14), { enabled: true, size: 5 });
    expect(JSON.stringify(second.bundles[0])).toBe(JSON.stringify(first.bundles[0]));
    expect(JSON.stringify(second.bundles[1])).toBe(JSON.stringify(first.bundles[1]));
  });

  it('skips a bundle the window no longer reaches', () => {
    bundleWindow(CHANNEL, window(10), { enabled: true, size: 5 });
    // The window has scrolled past the first bundle entirely.
    const later = bundleWindow(CHANNEL, window(5, 6), { enabled: true, size: 5 });
    expect(later.bundles).toHaveLength(1);
    expect(JSON.stringify(later.bundles[0])).toContain('"id":"6"');
    // Anchored on the id: "message 1" is a substring of "message 10".
    expect(JSON.stringify(later.bundles[0])).not.toContain('"id":"1"');
  });

  it('accounts for every message exactly once', () => {
    const result = bundleWindow(CHANNEL, window(13), { enabled: true, size: 5 });
    const inBundles = JSON.stringify(result.bundles);
    const seen = window(13).filter((entry) => inBundles.includes(`"id":"${entry.id}"`)).length;
    expect(seen + result.loose.length).toBe(13);
  });
});
