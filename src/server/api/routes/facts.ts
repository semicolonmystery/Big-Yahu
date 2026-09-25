import { Router } from 'express';
import { factCountsByPerson } from '../../db/repositories/factIndexRepo';
import {
  searchFacts, listFactsPage, ensureFactIndex, deleteFact, peopleIn } from '../../db/repositories/factsRepo';
import { factTypeIds } from '../../db/repositories/factTypesRepo';
import { getMessages } from '../../db/repositories/cachedMessagesRepo';
import { getSettings } from '../../db/repositories/settingsRepo';
import { mentionedUserIds } from '@shared/discord';
import { displayNames } from '../names';
import type { Fact, FactWithSources, SourceMessage, FactPage, FactAuthor } from '@shared/types';

export const factsRouter = Router();

function readQuery(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { query } = body as { query?: unknown };
  if (typeof query !== 'string') return null;
  const trimmed = query.trim();
  return trimmed || null;
}

function readTopK(body: unknown): number | null | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { topK } = body as { topK?: unknown };
  if (topK === undefined) return undefined;
  if (typeof topK !== 'number' || !Number.isInteger(topK)) return null;
  return Math.min(50, Math.max(1, topK));
}

function parseIntParam(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readAuthorId(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw ? raw : undefined;
}

/**
 * Resolves the `<@id>` mentions across a batch of facts in one lookup, then
 * splits the result back out per fact. The gateway fills in whoever never wrote
 * a cached message — the bot itself, most of all, since it does not record its
 * own lines and so could never name itself.
 */
function resolveMentionNames(facts: { text: string }[]): Record<string, string>[] {
  const idsByFact = facts.map((fact) => mentionedUserIds(fact.text));
  return namesPerFact(idsByFact);
}

/** The same lookup for everyone a fact records, which the text does not always name. */
function resolvePeopleNames(facts: Fact[]): Record<string, string>[] {
  return namesPerFact(facts.map((fact) => peopleIn(fact)));
}

function namesPerFact(idsByFact: string[][]): Record<string, string>[] {
  const allIds = [...new Set(idsByFact.flat())];
  const names = displayNames(allIds);
  return idsByFact.map((ids) =>
    Object.fromEntries(ids.filter((id) => names[id]).map((id) => [id, names[id]])),
  );
}

/** Only types that exist, so a hand-typed query cannot filter the screen into nothing. */
function readTypes(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const known = new Set(factTypeIds());
  return [...new Set(raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => known.has(entry)))];
}

factsRouter.post('/search', async (req, res) => {
  const query = readQuery(req.body);
  if (!query) {
    res.status(400).json({ success: false, error: 'query is required' });
    return;
  }

  const topK = readTopK(req.body);
  if (topK === null) {
    res.status(400).json({ success: false, error: 'topK must be an integer' });
    return;
  }

  const facts = await searchFacts(query, topK ?? getSettings().factSearchTopK);

  const allMessageIds = [...new Set(facts.flatMap((fact) => fact.metadata.messageIds))];
  const messages = getMessages(allMessageIds);
  const messagesById = new Map(messages.map((message) => [message.messageId, message]));
  const mentionNames = resolveMentionNames(facts);
  const peopleNames = resolvePeopleNames(facts);

  const data: FactWithSources[] = facts.map((fact, i) => ({
    ...fact,
    sourceMessages: fact.metadata.messageIds
      .map((id) => messagesById.get(id))
      .filter((message): message is SourceMessage => message !== undefined),
    mentionNames: mentionNames[i],
    peopleNames: peopleNames[i],
  }));

  res.json({ success: true, data });
});

factsRouter.get('/', async (req, res) => {
  const page = parseIntParam(req.query.page, 1);
  if (page === null || page < 1) {
    res.status(400).json({ success: false, error: 'page must be a positive integer' });
    return;
  }

  const pageSize = parseIntParam(req.query.pageSize, 25);
  if (pageSize === null || pageSize < 1 || pageSize > 100) {
    res.status(400).json({ success: false, error: 'pageSize must be an integer between 1 and 100' });
    return;
  }

  const authorId = readAuthorId(req.query.authorId);
  const types = readTypes(req.query.types);

  const { facts, total } = await listFactsPage({ page, pageSize, authorId, types });

  const allMessageIds = [...new Set(facts.flatMap((fact) => fact.metadata.messageIds))];
  const messages = getMessages(allMessageIds);
  const messagesById = new Map(messages.map((message) => [message.messageId, message]));
  const mentionNames = resolveMentionNames(facts);
  const peopleNames = resolvePeopleNames(facts);

  const data: FactWithSources[] = facts.map((fact, i) => ({
    ...fact,
    distance: null,
    sourceMessages: fact.metadata.messageIds
      .map((id) => messagesById.get(id))
      .filter((message): message is SourceMessage => message !== undefined),
    mentionNames: mentionNames[i],
    peopleNames: peopleNames[i],
  }));

  const result: FactPage = { facts: data, total, page, pageSize };
  res.json({ success: true, data: result });
});

factsRouter.get('/authors', async (_req, res) => {
  // Counted in SQLite rather than by reading every fact out of Chroma: this
  // screen is a filter list, and it used to cost the whole collection to draw.
  await ensureFactIndex();
  const counts = factCountsByPerson();

  // A fact can be about someone who did not write any of its source messages.
  // Resolve all indexed people from the full cache and Discord, just as the
  // mentions inside the fact text are resolved.
  const authorIds = [...counts.keys()];
  const names = displayNames(authorIds);

  const data: FactAuthor[] = [...counts.entries()]
    .map(([authorId, factCount]) => ({
      authorId,
      authorUsername: names[authorId] ?? authorId,
      factCount,
    }))
    .sort((a, b) => b.factCount - a.factCount);

  res.json({ success: true, data });
});

factsRouter.delete('/:id', async (req, res) => {
  const deleted = await deleteFact(req.params.id);
  if (!deleted) {
    res.status(404).json({ success: false, error: 'Fact not found' });
    return;
  }
  res.json({ success: true, data: { id: req.params.id } });
});
