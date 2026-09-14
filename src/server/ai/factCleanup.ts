import { collectionFor, collectionNameFor } from '../db/chroma';
import { activeEmbedding, embedWith } from './embeddings';
import { embeddingText, factsByIds, ensureFactIndex } from '../db/repositories/factsRepo';
import { factIdsOfTypes, indexFacts, untypedFactIds } from '../db/repositories/factIndexRepo';
import { factTypesForModel, knownTypes } from '../db/repositories/factTypesRepo';
import { getMessages } from '../db/repositories/cachedMessagesRepo';
import { createJob, markCopied, openJob, type ReembedJob } from '../db/repositories/reembedRepo';
import { structured } from './structured';
import { cleanupSchemaFor, type CleanupResult } from './schemas';
import { effectivePrompt } from '../db/repositories/promptsRepo';
import { renderMaterial } from './material';
import { formatNow } from '@shared/constants';
import { getSettings } from '../db/repositories/settingsRepo';
import type { Fact } from '@shared/types';

/**
 * The one-off pass over facts stored before the bot knew what it knows now.
 *
 * It is the backstop that replaced the date-repair call: rather than a regex
 * catching a fuzzy date on the way in, the prompts are asked to write dates
 * correctly and this can be re-run over everything whenever the rules change.
 * It is also what assigns types to the facts that predate them.
 *
 * It rides on the re-embed job runner rather than a second one — snapshot a set
 * of fact ids, work through them in checkpointed batches, pause, continue,
 * reset, resume after a restart, and never start on its own — because that is
 * exactly the shape this needs and the machinery is already proven.
 *
 * Unlike a re-embed, it writes **in place**: the fact keeps its id, its sources
 * and its references, and the rewritten text is re-embedded in the same step,
 * because a fact whose wording changed has a vector that no longer describes it.
 * There is no target collection to verify against and no swap.
 */

/** The sentinel for "the ones nobody has sorted", which is every fact predating types. */
export const UNTYPED_FILTER = 'untyped';

/** Enough to be worth a call, few enough that one bad answer costs little. */
export const DEFAULT_BUNDLE_SIZE = 12;
export const MAX_BUNDLE_SIZE = 50;

export interface CleanupPlan {
  /** How many facts the chosen filter would go over. */
  facts: number;
  untyped: number;
  collection: string;
}

function idsForFilter(types: string[]): string[] {
  if (types.includes(UNTYPED_FILTER)) {
    const rest = types.filter((type) => type !== UNTYPED_FILTER);
    return [...new Set([...untypedFactIds(), ...(rest.length > 0 ? factIdsOfTypes(rest) : [])])];
  }
  return factIdsOfTypes(types);
}

export async function planCleanup(types: string[] = []): Promise<CleanupPlan> {
  await ensureFactIndex();
  return {
    facts: idsForFilter(types).length,
    untyped: untypedFactIds().length,
    collection: collectionNameFor(activeEmbedding()),
  };
}

/**
 * Opens a cleanup job over the facts the filter names.
 *
 * Limiting it to a few types is what keeps it affordable: a run over `rule` and
 * `decision` is a few hundred facts, and one over `message` is the whole
 * channel. The snapshot comes from the SQLite mirror rather than from Chroma,
 * because "the ones with no types at all" cannot be expressed as a where-clause
 * against a key that is not there.
 */
export async function startCleanup(types: string[] = [], bundleSize = DEFAULT_BUNDLE_SIZE): Promise<ReembedJob | null> {
  if (openJob()) return null;
  await ensureFactIndex();
  const ids = idsForFilter(types);
  if (ids.length === 0) return null;

  const collection = collectionNameFor(activeEmbedding());
  const embedding = activeEmbedding();
  const job = createJob({
    kind: 'cleanup',
    typeFilter: types.join(' '),
    bundleSize: Math.min(MAX_BUNDLE_SIZE, Math.max(1, Math.round(bundleSize))),
    sourceModel: embedding.model,
    sourceDimensions: embedding.dimensions,
    sourceCollection: collection,
    targetModel: embedding.model,
    targetDimensions: embedding.dimensions,
    targetCollection: collection,
    // Recall keeps working throughout: a fact being tidied is still a fact, and
    // the collection is never half-filled the way it is during a re-embed.
    pausesRecall: false,
  }, ids);
  console.log(`[cleanup] going over ${ids.length} fact(s) in ${collection}, ${job.bundleSize} at a time`);
  return job;
}

interface BundleFact {
  id: string;
  text: string;
  types: string[];
  storedAt: string;
  sources?: Array<{ authorId: string; content: string }>;
}

function bundleFor(facts: Fact[], withSources: Set<string>): BundleFact[] {
  const sourceIds = facts.filter((fact) => withSources.has(fact.id)).flatMap((fact) => fact.metadata.messageIds);
  const byId = new Map(getMessages(sourceIds).map((message) => [message.messageId, message]));
  return facts.map((fact) => {
    const sources = withSources.has(fact.id)
      ? fact.metadata.messageIds
        .map((id) => byId.get(id))
        .filter((message) => message !== undefined)
        .map((message) => ({ authorId: message.authorId, content: message.content }))
      : [];
    return {
      id: fact.id,
      text: fact.text,
      types: fact.metadata.types ?? [],
      storedAt: new Date(fact.metadata.createdAt).toISOString(),
      ...(sources.length > 0 ? { sources } : {}),
    };
  });
}

async function askModel(facts: Fact[], withSources: Set<string>): Promise<CleanupResult> {
  const types = factTypesForModel();
  return structured<CleanupResult>('factCleanup', {
    system: effectivePrompt('factCleanup'),
    user: renderMaterial({
      now: formatNow(getSettings().timezone),
      task: 'Bring these stored facts up to the current rules, changing nothing that is already right.',
      factTypes: types,
      facts: bundleFor(facts, withSources),
    }),
    schema: cleanupSchemaFor(types.map((type) => type.id)),
    maxOutputTokens: 32_768,
  });
}

/**
 * One bundle.
 *
 * Every fact in it is marked done whatever happens, including when the call
 * fails outright: this job runs over every fact the bot owns, and a model having
 * a bad minute must not leave a batch cycling forever or, worse, half-written. A
 * failed bundle changes nothing and the job moves on.
 */
export async function cleanupBatch(job: ReembedJob, ids: string[]): Promise<void> {
  const facts = await factsByIds(ids);
  if (facts.length === 0) { markCopied(job.id, ids); return; }

  let answer: CleanupResult | null = null;
  try {
    answer = await askModel(facts, new Set());
    // Facts it could not judge from the text alone get one more go with the
    // messages they came from, shaped like the escalation everything else uses
    // rather than a second mechanism.
    const wantsSources = new Set(answer.facts.filter((entry) => entry.needsSources).map((entry) => entry.id));
    if (wantsSources.size > 0) {
      console.log(`[cleanup] re-asking with sources for ${wantsSources.size} fact(s)`);
      const second = await askModel(facts.filter((fact) => wantsSources.has(fact.id)), wantsSources);
      const kept = answer.facts.filter((entry) => !wantsSources.has(entry.id));
      answer = { facts: [...kept, ...second.facts] };
    }
  } catch (error) {
    console.error(`[cleanup] a bundle of ${facts.length} was left alone after a failure:`, error);
    markCopied(job.id, ids);
    return;
  }

  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const rewrites = answer.facts
    .map((entry) => ({ entry, fact: byId.get(entry.id) }))
    .filter((pair): pair is { entry: CleanupResult['facts'][number]; fact: Fact } => pair.fact !== undefined)
    .map(({ entry, fact }) => {
      const text = entry.text.trim();
      const types = knownTypes(entry.types);
      const textChanged = text.length > 0 && text !== fact.text;
      const typesChanged = types.join(' ') !== (fact.metadata.types ?? []).join(' ');
      return { fact, text: textChanged ? text : fact.text, types, textChanged, typesChanged };
    })
    // A fact the model could not improve comes back unchanged, and unchanged
    // means untouched: no write, no embedding, no cost.
    .filter((rewrite) => rewrite.textChanged || rewrite.typesChanged);

  if (rewrites.length > 0) {
    const collection = await collectionFor(activeEmbedding());
    const metadataFor = (rewrite: typeof rewrites[number]) => ({
      ...rewrite.fact.metadata,
      // Chroma rejects an empty array, and its absence is what marks a fact
      // nobody has sorted — so a model that returned none leaves it untyped.
      ...(rewrite.types.length > 0 ? { types: rewrite.types } : {}),
    }) as never;

    // Two writes, because they are two different changes. A fact whose wording
    // changed needs a new vector — its old one describes a sentence that is no
    // longer there — and one that only gained a type must not be sent an empty
    // embedding, which Chroma refuses.
    const reworded = rewrites.filter((rewrite) => rewrite.textChanged);
    if (reworded.length > 0) {
      const embeddings = await embedWith(reworded.map((rewrite) => embeddingText(rewrite.text)), activeEmbedding());
      await collection.update({
        ids: reworded.map((rewrite) => rewrite.fact.id),
        documents: reworded.map((rewrite) => rewrite.text),
        metadatas: reworded.map(metadataFor),
        embeddings,
      });
      for (const rewrite of reworded) {
        console.log(`[cleanup] rewrote ${rewrite.fact.id}: "${rewrite.fact.text.slice(0, 60)}" -> "${rewrite.text.slice(0, 60)}"`);
      }
    }

    const sortedOnly = rewrites.filter((rewrite) => !rewrite.textChanged);
    if (sortedOnly.length > 0) {
      await collection.update({
        ids: sortedOnly.map((rewrite) => rewrite.fact.id),
        metadatas: sortedOnly.map(metadataFor),
      });
      console.log(`[cleanup] sorted ${sortedOnly.length} fact(s) into types without touching their wording`);
    }

    indexFacts(rewrites.map((rewrite) => ({
      ...rewrite.fact,
      text: rewrite.text,
      metadata: { ...rewrite.fact.metadata, types: rewrite.types },
    })));
  }

  markCopied(job.id, ids);
}
