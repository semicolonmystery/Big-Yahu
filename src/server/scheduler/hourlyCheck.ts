import type { Client, TextBasedChannel } from 'discord.js';
import { runExtractionForChannel } from '../ai/factExtraction';
import { listCheckpoints } from '../db/repositories/checkpointRepo';
import { getSettings } from '../db/repositories/settingsRepo';
import { isServedGuild } from '../env';
import { canExtractFrom } from '../db/repositories/channelSettingsRepo';

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function runCheckNow(client: Client): Promise<number> {
  if (running) return 0;
  running = true;

  let created = 0;
  try {
    for (const checkpoint of listCheckpoints()) {
      // Checkpoints can outlive a guild change or a permission change.
      if (!isServedGuild(checkpoint.guildId)) continue;
      if (!canExtractFrom(checkpoint.channelId)) continue;

      const channel = await client.channels.fetch(checkpoint.channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) continue;

      try {
        created += await runExtractionForChannel(channel as TextBasedChannel, checkpoint.guildId);
      } catch (error) {
        console.error(`[scheduler] extraction failed for channel ${checkpoint.channelId}:`, error);
      }
    }
  } finally {
    running = false;
  }
  return created;
}

/**
 * Reschedules itself after every run so an interval change in the admin panel
 * takes effect on the next tick without a restart.
 */
export function startScheduler(client: Client): void {
  const tick = async () => {
    const created = await runCheckNow(client);
    if (created > 0) console.log(`[scheduler] stored ${created} new fact(s)`);
    schedule();
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), getSettings().checkIntervalMinutes * 60 * 1000);
  };

  schedule();
}
