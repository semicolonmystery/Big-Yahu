import { Router } from 'express';
import { discordClient } from '../../bot/client';
import { env } from '../../env';
import { guildPeople } from '../../ai/context';
import type { GuildMember } from '@shared/types';

export const peopleRouter = Router();

/**
 * Who is in the guild, for the panel that adds a controller by name.
 *
 * Ids are what get stored — they survive somebody renaming themselves, which is
 * the whole reason facts stopped keeping display names — but an id is the one
 * thing a person cannot read. So the id stays the key and the name is what the
 * operator sees, resolved here.
 *
 * It is what the bot can currently see, not the full membership: somebody
 * offline who has not spoken lately is absent from the caches. `botOnline` says
 * whether an empty list means "nobody" or "the bot is not connected".
 */
peopleRouter.get('/', (_req, res) => {
  const guild = env.discordGuildId ? discordClient.guilds.cache.get(env.discordGuildId) : undefined;
  const people: GuildMember[] = guild
    ? guildPeople(guild, discordClient.user?.id)
      .map((person) => ({ id: person.id, name: person.name, username: person.username ?? null }))
      .sort((first, second) => first.name.localeCompare(second.name))
    : [];
  res.json({ success: true, data: { people, botOnline: discordClient.isReady() } });
});
