import type { Client, TextBasedChannel } from 'discord.js';
import { runExtractionForChannel } from '../ai/factExtraction';
import { listCheckpoints } from '../db/repositories/checkpointRepo';
import { getSettings } from '../db/repositories/settingsRepo';
import { isServedGuild } from '../env';
import { canExtractFrom } from '../db/repositories/channelSettingsRepo';

let timer: NodeJS.Timeout | null = null;
let activeRun: Promise<number> | null = null;
let schedulerEnabled = false;

export function runCheckNow(client: Client): Promise<number> {
  if (activeRun) return Promise.resolve(0);
  activeRun = Promise.resolve().then(async () => {
    let created = 0;
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
    return created;
  }).finally(() => {
    activeRun = null;
  });
  return activeRun;
}

/**
 * Reschedules itself after every run so an interval change in the admin panel
 * takes effect on the next tick without a restart.
 */
export function startScheduler(client: Client): void {
  schedulerEnabled = true;
  const tick = async () => {
    try {
      const created = await runCheckNow(client);
      if (created > 0) console.log(`[scheduler] stored ${created} new fact(s)`);
    } catch (error) {
      console.error('[scheduler] check failed:', error);
    } finally {
      schedule();
    }
  };

  const schedule = () => {
    if (!schedulerEnabled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), getSettings().checkIntervalMinutes * 60 * 1000);
  };

  schedule();
}

/** Stop future ticks and wait for any manual or scheduled extraction to finish. */
export async function stopScheduler(): Promise<void> {
  schedulerEnabled = false;
  if (timer) clearTimeout(timer);
  timer = null;
  await activeRun?.catch(() => undefined);
}
