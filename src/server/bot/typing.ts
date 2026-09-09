import type { Message } from 'discord.js';

// Discord's typing indicator expires after ~10s, so it has to be re-sent while work continues.
const REFRESH_MS = 8_000;

interface ChannelTyping {
  active: number;
  timer: NodeJS.Timeout;
}

const channels = new Map<string, ChannelTyping>();

/**
 * Shows "Big Yahu is typing…" until the returned function is called. Several
 * replies in flight in the same channel share one indicator; it stays up until
 * the last of them finishes.
 */
export function startTyping(message: Message): () => void {
  const channel = message.channel;
  if (!('sendTyping' in channel)) return () => {};

  const send = () => channel.sendTyping().catch(() => {});
  const existing = channels.get(channel.id);

  if (existing) {
    existing.active += 1;
  } else {
    void send();
    channels.set(channel.id, { active: 1, timer: setInterval(send, REFRESH_MS) });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const state = channels.get(channel.id);
    if (!state) return;
    state.active -= 1;
    if (state.active <= 0) {
      clearInterval(state.timer);
      channels.delete(channel.id);
    }
  };
}
