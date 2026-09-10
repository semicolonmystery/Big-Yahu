import { Client, GatewayIntentBits } from 'discord.js';

export const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Non-privileged. Discord Admin uses the live voice-state cache to avoid
    // sending mute, deafen, move or disconnect requests for absent members.
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    // Privileged, like MessageContent: enable "Presence Intent" in the developer
    // portal or the bot cannot see what anyone is playing.
    GatewayIntentBits.GuildPresences,
  ],
});
