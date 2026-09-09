import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { env } from '../env';
import { discordClient } from '../bot/client';

let lastChroma: { at: number; ok: boolean } | undefined;
let checking: Promise<boolean> | undefined;
async function chromaReady(): Promise<boolean> {
  if (lastChroma && Date.now() - lastChroma.at < 10_000) return lastChroma.ok;
  if (!checking) checking = (async () => {
    try {
      const response = await fetch(`http://${env.chromaHost}:${env.chromaPort}/api/v2/heartbeat`, {
        signal: AbortSignal.timeout(2_000), redirect: 'error',
      });
      await response.body?.cancel();
      return response.ok;
    } catch { return false; }
  })().then((ok) => { lastChroma = { at: Date.now(), ok }; return ok; }).finally(() => { checking = undefined; });
  return checking;
}

export async function healthStatus() {
  let database = true;
  try { db.get(sql`select 1`); } catch { database = false; }
  const botEnabled = Boolean(env.discordToken);
  const discord = !botEnabled || discordClient.isReady();
  const chroma = !botEnabled || await chromaReady();
  return { ok: database && discord && chroma, database, discord, chroma, mode: botEnabled ? 'bot' : 'admin-only' };
}
