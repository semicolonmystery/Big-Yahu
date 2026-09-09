import { createApp } from './app';
import { env } from './env';
import { runMigrations } from './db/client';
import { seedFromSettings } from './db/repositories/chatModelsRepo';
import { discordClient } from './bot/client';
import { registerReady } from './bot/events/ready';
import { registerMessageCreate } from './bot/events/messageCreate';
import { attachDiscordClient, loadPlugins } from './plugins/engine';
import { startScheduler } from './scheduler/hourlyCheck';

runMigrations();
seedFromSettings();
await loadPlugins();

createApp().listen(env.port, () => {
  console.log(`[api] listening on port ${env.port}`);
});

if (env.discordToken) {
  console.log(
    env.discordGuildId
      ? `[bot] serving guild ${env.discordGuildId} only`
      : '[bot] DISCORD_GUILD_ID is not set — responding in every guild it has joined',
  );
  registerReady(discordClient, (client) => {
    attachDiscordClient(client);
    startScheduler(client);
  });
  registerMessageCreate(discordClient);
  discordClient.login(env.discordToken).catch((error: unknown) => {
    console.error('[bot] login failed:', error);
  });
} else {
  console.log('[bot] no DISCORD_TOKEN set — running the admin panel only');
}
