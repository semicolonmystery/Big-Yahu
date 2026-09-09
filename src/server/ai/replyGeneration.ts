import { FunctionCallingConfigMode } from '@google/genai';
import type { Content, FunctionCall, FunctionDeclaration, GenerateContentResponse } from '@google/genai';
import type { Message } from 'discord.js';
import { generate } from './generate';
import {
  effectiveMaxDepth,
  fetchOlderMessages,
  fetchRecentMessages,
  formatFacts,
  formatTranscript,
  listGuildPeople,
  mentionRoster,
  toWindowMessage,
} from './context';
import type { WindowMessage } from './context';
import {
  deleteFactDeclaration,
  listPeopleDeclaration,
  readChannelDeclaration,
  replyToDeclaration,
  requestMoreContextDeclaration,
  saveFactDeclaration,
  staySilentDeclaration,
} from './schemas';
import { resolveReadableChannel } from '../bot/channelAccess';
import { addFacts, deleteFact, searchFacts } from '../db/repositories/factsRepo';
import { cacheMessages, getMessages } from '../db/repositories/cachedMessagesRepo';
import { getSettings } from '../db/repositories/settingsRepo';
import { canExtractFrom } from '../db/repositories/channelSettingsRepo';
import type { TextAttachmentBudget } from '../bot/textAttachments';
import { DISCORD_MESSAGE_LIMIT } from '@shared/constants';
import {
  mentionedUserIds,
  normaliseFactMentions,
  restoreMentions,
  stripPromptMarkers,
  stripUnknownJumpLinks,
  stripUnknownMentions,
} from '@shared/discord';
import type { Fact } from '@shared/types';
import type { DraftPrompt } from '@big-yahu/plugin-sdk';
import { collectTools, runTool } from '../plugins/engine';
import type { ResolvedTool } from '../plugins/engine';

export interface GeneratedReply {
  text: string;
  savedFactIds: string[];
  /** How many times the model asked for older history before answering. */
  contextRequests: number;
  /** The model chose to send nothing at all. */
  silent: boolean;
  deletedFactIds: string[];
  /**
   * The message the reply should hang under. Null means the one that tagged the
   * bot, which is nearly always right.
   */
  replyToMessageId: string | null;
}

/** A slice of another channel's history, pulled in because the bot was pointed at it. */
export interface ForeignChannelMessages {
  channelId: string;
  channelName: string;
  messages: WindowMessage[];
}

export interface ReplyContext {
  guildId: string;
  channelId: string;
  taggedMessage: Message;
  windowMessages: WindowMessage[];
  /** Read automatically because the tagging message mentioned those channels. */
  foreignMessages?: ForeignChannelMessages[];
  quotedMessages?: WindowMessage[];
  attachmentBudget?: TextAttachmentBudget;
}

interface SaveFactArgs {
  text?: unknown;
  referencedFactIds?: unknown;
}

type ToolResponses = Record<string, Record<string, unknown>>;

/**
 * Said back to the model after every tool it calls. A bare `{ status: 'done' }`
 * was the last thing in the conversation before it wrote the reply, and it
 * paraphrased it — in English, whatever language the channel was speaking.
 */
const REPLY_NOW =
  'Now write the message that actually gets posted to the channel, in the language the conversation '
  + 'is in. Never describe what you just did: nobody can see your tools, so a message reporting them '
  + 'is not a reply.';

const NARRATION_MAX_LENGTH = 160;

const NARRATION_PATTERNS = [
  /\ball done\b/i,
  /\bi'?m done\b/i,
  /\bi am done\b/i,
  /\bstaying silent\b/i,
  /\bno fact to save\b/i,
  /\bnothing (?:else |further )?(?:needed|to add|to save|to do)\b/i,
  /\breputation assessed\b/i,
  /\bassessed (?:the )?reputation\b/i,
  /\bi have (?:replied|responded|answered)\b/i,
  /\bnothing further\b/i,
  /\btask complete/i,
  /^done[.!]?$/i,
];

/**
 * The last net under the reply, for the model narrating its own tool use instead
 * of answering — "no fact to save, reputation assessed, all done." It is only
 * cast on a turn that answered a tool call, which is the only place that text
 * has ever appeared, so an ordinary reply cannot trip it. Every catch is logged,
 * because this list only grows by seeing what got through.
 */
function looksLikeToolNarration(text: string): boolean {
  if (text.length > NARRATION_MAX_LENGTH) return false;
  // A real reply pings people and links moments; a status line does neither.
  if (/<@!?\d+>|https:\/\/discord\.com\/channels\//.test(text)) return false;
  return NARRATION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The reply text, read off the parts directly.
 *
 * `response.text` does the same thing, and logs a warning about the non-text
 * parts every single time — which on a bot that calls a tool on nearly every
 * reply means the log is mostly that warning. Thought parts are skipped, exactly
 * as the accessor does: the model's reasoning is not the message.
 */
function textOf(response: GenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text)
    .join('')
    .trim();
}

/**
 * The model's own turn must be echoed back exactly as received — Gemini 3
 * attaches a thoughtSignature to tool-call parts and rejects a rebuilt copy.
 */
function functionResponseTurn(
  modelTurn: Content | undefined,
  calls: FunctionCall[],
  responses: Map<FunctionCall, Record<string, unknown>>,
): Content[] {
  const turns: Content[] = [];
  if (modelTurn) turns.push(modelTurn);
  turns.push({
    role: 'user',
    parts: calls.map((call) => ({
      functionResponse: {
        name: call.name,
        ...(call.id ? { id: call.id } : {}),
        response: responses.get(call) ?? { error: 'This tool was not executed.', note: REPLY_NOW },
      },
    })),
  });
  return turns;
}

export async function generateReply(draft: DraftPrompt, context: ReplyContext): Promise<GeneratedReply> {
  const settings = getSettings();
  const maxDepth = effectiveMaxDepth();
  const lookbackMs = settings.escalationLookbackHours * 60 * 60 * 1000;

  const conversation: Content[] = [...draft.conversation];
  // Everything already read out of another channel counts as seen, or the
  // sanitisers below would strip the very jump links and mentions the prompt
  // just handed the model.
  const foreignMessages = (context.foreignMessages ?? []).flatMap((read) => read.messages);
  const localMessages = [...context.windowMessages, ...(context.quotedMessages ?? [])];
  const knownMessageIds = new Set<string>([
    context.taggedMessage.id,
    ...localMessages.map((message) => message.id),
    ...foreignMessages.map((message) => message.id),
    ...draft.sourceMessages.map((message) => message.messageId),
  ]);
  const knownUserIds = new Set<string>([
    ...localMessages.map((message) => message.authorId),
    context.taggedMessage.author.id,
    ...foreignMessages.map((message) => message.authorId),
    ...draft.sourceMessages.map((message) => message.authorId),
  ]);
  const knownFactIds = new Set(draft.retrievedFacts.map((fact) => fact.id));
  for (const content of draft.conversation) for (const part of content.parts ?? []) {
    if (part.text) for (const id of mentionedUserIds(part.text)) knownUserIds.add(id);
  }
  // Discord can only hang a reply under a message in the same channel, so this
  // is deliberately narrower than knownMessageIds — which also holds anything
  // read out of another channel, and the sources under a recalled fact.
  const channelMessageIds = new Set<string>([
    context.taggedMessage.id,
    ...localMessages.map((message) => message.id),
  ]);

  let olderMessages: WindowMessage[] = [];
  let contextRequests = 0;
  const savedFactIds: string[] = [];
  const deletedFactIds: string[] = [];
  let replyToMessageId: string | null = null;

  // Prose the model wrote in the same turn as a fire-and-forget tool call. That
  // is the shape the reputation plugin is designed for — assess the person on
  // the reply you are already making — and throwing it away made the model
  // answer once, get asked again, and narrate the second time round.
  let pendingText = '';

  /** Messages from elsewhere become quotable, linkable and cached, exactly like the window. */
  const absorbForeign = (channelId: string, messages: WindowMessage[]): void => {
    cacheMessages(
      messages.map((message) => ({
        messageId: message.id,
        channelId,
        guildId: context.guildId,
        authorId: message.authorId,
        authorUsername: message.authorUsername,
        content: message.content,
        messageCreatedAt: message.createdAt,
      })),
    );
    for (const message of messages) {
      knownMessageIds.add(message.id);
      knownUserIds.add(message.authorId);
      for (const id of mentionedUserIds(message.content)) knownUserIds.add(id);
      foreignMessages.push(message);
    }
  };

  // Plugin tools are resolved once per reply, not per turn.
  const pluginTools = collectTools();
  const pluginByName = new Map<string, ResolvedTool>(
    pluginTools.map((resolved) => [resolved.declaration.name ?? '', resolved]),
  );
  // A tool answering with something that prompts another call must not loop forever.
  let toolCalls = 0;
  const MAX_TOOL_CALLS = 10;
  // The roster does not change between turns, so asking twice is already a sign
  // the model is going round rather than answering.
  let peopleListings = 0;
  const MAX_PEOPLE_LISTINGS = 2;
  // A turn that says nothing at all and calls nothing. Rare, and not a decision.
  let emptyTurns = 0;
  const MAX_EMPTY_TURNS = 2;
  // Reading elsewhere is a whole extra page of transcript each time, so it is
  // budgeted harder than the roster.
  let channelReads = 0;
  const MAX_CHANNEL_READS = 2;
  // Every branch below continues, so this is the only thing standing between a
  // model that keeps reaching for tools it is still allowed and an endless loop.
  const MAX_TURNS = 12;

  /** Runs the plugin tools called in one turn, answering honestly when the budget is spent. */
  const dispatchPluginCalls = async (calls: FunctionCall[]): Promise<ToolResponses> => {
    const responses: ToolResponses = {};
    for (const call of calls) {
      const resolved = pluginByName.get(call.name ?? '');
      if (!resolved) continue;

      if (toolCalls >= MAX_TOOL_CALLS) {
        // Saying "done" here would tell the model a tool ran when it never did.
        responses[call.name ?? ''] = {
          error: 'You have used up the tool calls for this reply. Answer with what you already have.',
        };
        continue;
      }
      toolCalls += 1;

      const result = await runTool(resolved, (call.args ?? {}) as Record<string, unknown>);
      // Everything crosses the boundary as JSON, so the model always gets a shape it can read.
      const payload =
        typeof result === 'object' && result !== null && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { result };
      responses[call.name ?? ''] = { ...payload, note: REPLY_NOW };
      console.log(`[plugins] ${resolved.pluginId}.${resolved.tool.name} answered`);
    }
    return responses;
  };

  /**
   * Reads another channel on demand. Everything it hands back becomes known, so
   * the reply may quote and link it; nothing here touches the extraction
   * checkpoints, which belong to the periodic pass.
   */
  const readForeignChannel = async (
    channelId: string,
    lookingFor: string,
  ): Promise<{ status: string; response: Record<string, unknown> }> => {
    if (!/^\d{5,}$/.test(channelId)) {
      return { status: 'not a channel id', response: { error: 'That is not a channel id.' } };
    }

    const access = await resolveReadableChannel(context.taggedMessage.client, context.guildId, channelId);
    if (!access.ok) return { status: access.reason, response: { error: access.reason } };

    const fetched = await fetchRecentMessages(access.channel, settings.crossChannelMessages, context.attachmentBudget);
    absorbForeign(channelId, fetched);

    let relatedFacts: Fact[] = [];
    if (lookingFor.trim()) {
      const found = await searchFacts(lookingFor, settings.factSearchTopK, {
        $and: [{ guildId: context.guildId }, { channelId }],
      });
      relatedFacts = found.filter(
        (fact) => fact.metadata.channelId === channelId && !knownFactIds.has(fact.id),
      );
      for (const fact of relatedFacts) knownFactIds.add(fact.id);
    }
    const sources = getMessages(relatedFacts.flatMap((fact) => fact.metadata.messageIds))
      .filter((source) => source.guildId === context.guildId && canExtractFrom(source.channelId));
    for (const source of sources) { knownMessageIds.add(source.messageId); knownUserIds.add(source.authorId); }
    for (const fact of relatedFacts) for (const id of mentionedUserIds(fact.text)) knownUserIds.add(id);

    return {
      status: `${fetched.length} message(s)`,
      response: {
        channel: `<#${channelId}>`,
        messages: fetched.length > 0 ? formatTranscript(fetched) : 'Nothing has been said in there recently.',
        remembered: relatedFacts.length > 0 ? formatFacts(relatedFacts) : 'Nothing stored about that channel matched.',
        sources,
        note:
          'These were said in a different channel from the one you are replying in. Say so if it matters, '
          + `and link them with that channel's id rather than this one's. ${REPLY_NOW}`,
      },
    };
  };

  /**
   * The book-keeping calls — where the reply hangs, what to remember, what to
   * forget — are applied on whatever turn they arrive on, rather than only on the
   * turn that also produces the reply. A fact the model decided to keep while it
   * was still asking for context used to be dropped on the floor.
   */
  const applyTurnCalls = async (calls: FunctionCall[]): Promise<ToolResponses> => {
    const responses: ToolResponses = {};

    const targetCall = calls.find((call) => call.name === 'reply_to');
    if (targetCall) {
      const messageId = typeof targetCall.args?.messageId === 'string' ? targetCall.args.messageId : '';
      if (channelMessageIds.has(messageId)) {
        const why = typeof targetCall.args?.why === 'string' ? targetCall.args.why : 'no reason given';
        console.log(`[bot] replying under ${messageId} instead: ${why}`);
        replyToMessageId = messageId;
        responses.reply_to = { attached: true, note: REPLY_NOW };
      } else {
        // A message from another channel, or one it never saw, cannot be replied
        // to — falling back to the tagging message beats failing the send.
        responses.reply_to = {
          attached: false,
          reason: 'That is not a message from this channel that you were shown. Your reply goes under the one that tagged you.',
          note: REPLY_NOW,
        };
      }
    }

    const deleteCall = calls.find((call) => call.name === 'delete_fact');
    if (deleteCall) {
      const factId = typeof deleteCall.args?.factId === 'string' ? deleteCall.args.factId : '';
      if (!canExtractFrom(context.channelId)) return { delete_fact: { deleted: false, error: 'Memory changes are disabled in this channel.' } };
      // Stable-ID updates already replaced this record. Do not delete its new version.
      if (savedFactIds.includes(factId)) return { delete_fact: { deleted: false, replaced: true, note: REPLY_NOW } };
      // Only facts actually shown in this turn, so a hallucinated id cannot delete anything.
      if (factId && knownFactIds.has(factId) && (await deleteFact(factId))) {
        const why = typeof deleteCall.args?.why === 'string' ? deleteCall.args.why : 'no reason given';
        console.log(`[bot] deleted fact ${factId}: ${why}`);
        deletedFactIds.push(factId);
        knownFactIds.delete(factId);
        responses.delete_fact = { deleted: true, note: REPLY_NOW };
      } else {
        responses.delete_fact = {
          deleted: false,
          reason: 'That fact id was not among the ones you were shown, so nothing was deleted.',
          note: REPLY_NOW,
        };
      }
    }

    const saveCall = calls.find((call) => call.name === 'save_fact');
    if (saveCall) {
      if (!canExtractFrom(context.channelId)) return { save_fact: { saved: false, error: 'Memory is disabled in this channel.' } };
      const args = (saveCall.args ?? {}) as SaveFactArgs;
      // Stored facts name people by id, not by whatever they are called today.
      const factText =
        typeof args.text === 'string'
            ? normaliseFactMentions(args.text.trim(), mentionRoster([...localMessages, ...foreignMessages, ...olderMessages]))
          : '';
      if (factText) {
        const referencedFactIds = Array.isArray(args.referencedFactIds)
          ? args.referencedFactIds.filter((id): id is string => typeof id === 'string' && knownFactIds.has(id))
          : [];
        const now = Date.now();
        const created = await addFacts([
          {
            text: factText,
            messageIds: [context.taggedMessage.id],
            authorIds: [context.taggedMessage.author.id],
            guildId: context.guildId,
            channelId: context.channelId,
            referencedFactIds,
            source: 'reply',
            timePeriodStart: now,
            timePeriodEnd: now,
          },
        ]);
        savedFactIds.push(...created);
        console.log(`[bot] saved ${created.length} fact(s) from a reply: ${factText.slice(0, 80)}`);
        responses.save_fact = { saved: created.length > 0, note: REPLY_NOW };
      } else {
        responses.save_fact = { saved: false, reason: 'The fact text was empty.', note: REPLY_NOW };
      }
    }

    return responses;
  };

  let answeredTools = false;
  let finalText = '';
  // Budgets apply to actual invocations, including repeated names in one response.
  let totalCalls = 0;
  const MAX_TOTAL_CALLS = 20;
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const lastTurn = turn === MAX_TURNS - 1;
    const declarations: FunctionDeclaration[] = [staySilentDeclaration, replyToDeclaration];
    if (canExtractFrom(context.channelId)) declarations.push(saveFactDeclaration, deleteFactDeclaration);
    // Keep declarations present for tool calls already in conversation history.
    declarations.push(requestMoreContextDeclaration, listPeopleDeclaration, readChannelDeclaration,
      ...pluginTools.map((tool) => tool.declaration));
    const response = await generate(conversation, {
      systemInstruction: draft.systemInstruction,
      tools: [{ functionDeclarations: declarations }],
      toolConfig: { functionCallingConfig: { mode: lastTurn ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO } },
      automaticFunctionCalling: { disable: true },
    });
    const calls = response.functionCalls ?? [];
    const modelTurn = response.candidates?.[0]?.content;
    let text = textOf(response);
    if (answeredTools && looksLikeToolNarration(text)) text = '';
    if (calls.length === 0) {
      if (text || pendingText) { finalText = text || pendingText; break; }
      if (++emptyTurns > MAX_EMPTY_TURNS || lastTurn) break;
      if (modelTurn?.parts?.length) conversation.push(modelTurn);
      conversation.push({ role: 'user', parts: [{ text: `You sent nothing. ${REPLY_NOW}` }] });
      continue;
    }
    const responses = new Map<FunctionCall, Record<string, unknown>>();
    let silent = false;
    let needsResult = false;
    let saveFailed = false;
    // Replacement is durable before any requested deletion, even when Gemini
    // emitted delete_fact first. Responses still retain the original call order.
    const ordered = [...calls].sort((a, b) => Number(b.name === 'save_fact') - Number(a.name === 'save_fact'));
    for (const call of ordered) {
      const name = call.name ?? '';
      try {
        if (lastTurn || ++totalCalls > MAX_TOTAL_CALLS) {
          responses.set(call, { error: 'Tool budget exhausted; this call was not executed.' });
          if (name === 'save_fact') saveFailed = true;
          continue;
        }
        if (name === 'stay_silent') {
          silent = true;
          responses.set(call, { silent: true });
        } else if (['save_fact', 'delete_fact', 'reply_to'].includes(name)) {
          if (name === 'delete_fact' && saveFailed) {
            responses.set(call, { deleted: false, error: 'Replacement was not saved; the original is retained.' });
            continue;
          }
          const result = await applyTurnCalls([call]);
          responses.set(call, result[name] ?? { error: 'Invalid tool arguments.' });
          if (name === 'save_fact' && result[name]?.saved !== true) saveFailed = true;
        } else if (name === 'request_more_context') {
          if (contextRequests >= maxDepth) { responses.set(call, { error: 'History budget exhausted.' }); continue; }
          contextRequests += 1;
          needsResult = true;
          const earliest = olderMessages[0] ?? context.windowMessages[0] ?? toWindowMessage(context.taggedMessage);
          const fetched = await fetchOlderMessages(context.taggedMessage.channel, earliest.id,
            earliest.createdAt - lookbackMs, context.attachmentBudget);
          olderMessages = [...fetched, ...olderMessages];
          if (canExtractFrom(context.channelId)) cacheMessages(fetched.map((message) => ({
            messageId: message.id, channelId: context.channelId, guildId: context.guildId,
            authorId: message.authorId, authorUsername: message.authorUsername,
            content: message.content, messageCreatedAt: message.createdAt,
          })));
          for (const message of fetched) {
            knownMessageIds.add(message.id); channelMessageIds.add(message.id); knownUserIds.add(message.authorId);
            for (const id of mentionedUserIds(message.content)) knownUserIds.add(id);
          }
          const lookingFor = typeof call.args?.lookingFor === 'string' ? call.args.lookingFor : '';
          const newFacts = lookingFor.trim()
            ? (await searchFacts(lookingFor, settings.factSearchTopK, { guildId: context.guildId }))
              .filter((fact) => canExtractFrom(fact.metadata.channelId) && !knownFactIds.has(fact.id)) : [];
          for (const fact of newFacts) knownFactIds.add(fact.id);
          const sources = getMessages(newFacts.flatMap((fact) => fact.metadata.messageIds))
            .filter((source) => source.guildId === context.guildId && canExtractFrom(source.channelId));
          for (const source of sources) { knownMessageIds.add(source.messageId); knownUserIds.add(source.authorId); }
          for (const fact of newFacts) for (const id of mentionedUserIds(fact.text)) knownUserIds.add(id);
          responses.set(call, {
            olderMessages: formatTranscript(fetched) || 'No older messages available.',
            additionalFacts: formatFacts(newFacts) || 'No further facts matched.',
            sources,
            note: contextRequests >= maxDepth ? `This was the final history batch. ${REPLY_NOW}` : REPLY_NOW,
          });
        } else if (name === 'list_people') {
          if (peopleListings >= MAX_PEOPLE_LISTINGS) { responses.set(call, { error: 'People listing budget exhausted.' }); continue; }
          peopleListings += 1;
          needsResult = true;
          const listing = listGuildPeople(context.taggedMessage,
            typeof call.args?.nameContains === 'string' ? call.args.nameContains : undefined);
          for (const id of mentionedUserIds(listing)) knownUserIds.add(id);
          responses.set(call, { people: listing, note: REPLY_NOW });
        } else if (name === 'read_channel') {
          if (settings.crossChannelMessages <= 0 || channelReads >= MAX_CHANNEL_READS) {
            responses.set(call, { error: 'Channel reading disabled or budget exhausted.' }); continue;
          }
          channelReads += 1;
          needsResult = true;
          const answer = await readForeignChannel(
            typeof call.args?.channelId === 'string' ? call.args.channelId.trim() : '',
            typeof call.args?.lookingFor === 'string' ? call.args.lookingFor : '',
          );
          responses.set(call, answer.response);
        } else if (pluginByName.has(name)) {
          const result = await dispatchPluginCalls([call]);
          responses.set(call, result[name] ?? { error: 'Plugin tool was not executed.' });
        } else {
          responses.set(call, { error: `Unknown tool: ${name}` });
        }
      } catch (error) {
        if (name === 'save_fact') saveFailed = true;
        console.error(`[bot] tool ${name} failed:`, error);
        responses.set(call, { error: 'Tool failed. Do not claim success or retry a mutation blindly.', note: REPLY_NOW });
        needsResult = true;
      }
    }
    if (silent) return { text: '', savedFactIds, deletedFactIds, contextRequests, silent: true, replyToMessageId };
    const rejected = [...responses.values()].some((result) => result.error || result.success === false
      || result.saved === false || (result.deleted === false && result.replaced !== true) || result.attached === false);
    if (rejected || needsResult) pendingText = '';
    if (rejected) needsResult = true;
    if (text && !needsResult) pendingText = text;
    conversation.push(...functionResponseTurn(modelTurn, calls, responses));
    answeredTools = true;
  }
  let text = finalText || pendingText;
  text = stripPromptMarkers(text);
  text = restoreMentions(text, mentionRoster([...localMessages, ...foreignMessages, ...olderMessages]));
  text = stripUnknownJumpLinks(text, knownMessageIds);
  // A member being cached does not mean that member was present in the prompt.
  text = stripUnknownMentions(text,
    (id) => context.taggedMessage.guild?.channels.cache.has(id) ?? false,
    (id) => knownUserIds.has(id));
  text = text.trim().slice(0, DISCORD_MESSAGE_LIMIT);
  if (!text) console.warn(`[bot] no reply text for ${context.taggedMessage.id}`);
  return { text, savedFactIds, deletedFactIds, contextRequests, silent: false, replyToMessageId };
}
