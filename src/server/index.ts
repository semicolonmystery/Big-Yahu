import { createApp } from './app';
import { env } from './env';
import { closeDatabase, runMigrations } from './db/client';
import { discordClient } from './bot/client';
import { registerReady } from './bot/events/ready';
import { drainMessageHandlers, registerMessageCreate } from './bot/events/messageCreate';
import { attachDiscordClient, loadPlugins } from './plugins/engine';
import { startScheduler, stopScheduler } from './scheduler/hourlyCheck';

runMigrations();
await loadPlugins();

const server = createApp().listen(env.port, () => {
  console.log(`[api] listening on port ${env.port}`);
});

let stopping: Promise<void> | undefined;
function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    console.log(`[runtime] shutting down (${reason})`);
    process.exitCode = exitCode;
    // Never close SQLite under active work; the OS releases handles on timeout.
    const deadline = setTimeout(() => {
      console.error('[runtime] shutdown timed out after 30 seconds');
      process.exit(1);
    }, 30_000);
    deadline.unref();
    try {
      const drained = await Promise.allSettled([
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
          });
        }),
        stopScheduler(),
        drainMessageHandlers(),
      ]);
      for (const result of drained) {
        if (result.status === 'rejected') {
          process.exitCode = 1;
          console.error('[runtime] could not drain a service:', result.reason);
        }
      }
      try {
        await discordClient.destroy();
      } finally {
        closeDatabase();
      }
    } catch (error) {
      process.exitCode = 1;
      console.error('[runtime] shutdown failed:', error);
    } finally {
      clearTimeout(deadline);
    }
  })();
  return stopping;
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
server.on('error', (error) => {
  console.error('[api] server failed:', error);
  void shutdown('HTTP server failure', 1);
});

if (env.discordToken) {
  console.log(`[bot] serving guild ${env.discordGuildId} only`);
  registerReady(discordClient, (client) => {
    if (stopping) return;
    attachDiscordClient(client);
    startScheduler(client);
  });
  registerMessageCreate(discordClient);
  discordClient.login(env.discordToken).catch((error: unknown) => {
    console.error('[bot] login failed:', error);
    void shutdown('Discord login failure', 1);
  });
} else {
  console.log('[bot] no DISCORD_TOKEN set — running the admin panel only');
}
