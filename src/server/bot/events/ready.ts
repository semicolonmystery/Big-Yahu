import { Events, type Client } from 'discord.js';

export function registerReady(client: Client, onReady: (client: Client<true>) => void): void {
  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[bot] logged in as ${readyClient.user.tag}`);
    onReady(readyClient);
  });
}
