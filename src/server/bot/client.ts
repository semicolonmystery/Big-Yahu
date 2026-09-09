import { Client, GatewayIntentBits } from 'discord.js';

export const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // Privileged, like MessageContent: enable "Presence Intent" in the developer
    // portal or the bot cannot see what anyone is playing.
    GatewayIntentBits.GuildPresences,
  ],
});
