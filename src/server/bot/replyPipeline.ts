import type { Message } from 'discord.js';
import { MessageType } from 'discord.js';
import { extractTopic } from '../ai/topicExtraction';
import { generateReply } from '../ai/replyGeneration';
import {
  fetchRecentMessages,
  markUnseenImages,
  presenceFor,
  selfMaterial,
  windowMessagesWithAttachments,
} from '../ai/context';
import { factsMaterial, messagesMaterial, peopleMaterial, renderMaterial } from '../ai/material';
import { factTypesForModel } from '../db/repositories/factTypesRepo';
import type { WindowMessage } from '../ai/context';
import type { ForeignChannelMessages } from '../ai/replyGeneration';
import { readableChannelRoster, resolveReadableChannel } from './channelAccess';
import { BillingError, OverloadedError } from '../ai/errors';
import { AIRequestBudgetError, withAIRequestBudget } from '../ai/requestBudget';
import { buildReplyInstruction } from '../ai/prompts/build';
import { recallFacts } from '../db/repositories/factsRepo';
import { isController } from '../db/repositories/controllersRepo';
import { getMessages, cacheMessages } from '../db/repositories/cachedMessagesRepo';
import { logReply } from '../db/repositories/replyLogRepo';
import { canExtractFrom } from '../db/repositories/channelSettingsRepo';
import { admitReply } from './replyAdmission';
import { createTextAttachmentBudget, type TextAttachmentBudget } from './textAttachments';
import { getSettings } from '../db/repositories/settingsRepo';
import { collectAnnotations, collectInstructions, runAfterReply, runBeforeReply } from '../plugins/engine';
import type { ContextUser, DraftPrompt } from '@big-yahu/plugin-sdk';
import { formatNow, languageName } from '@shared/constants';
import { mentionedUserIds } from '@shared/discord';
import { startTyping } from './typing';
import { imagePartsFor } from './attachments';

/**
 * Everyone the material actually refers to.
 *
 * The ids come from the material's own structure — who wrote each message, who
 * a fact came from, who the requester is — plus every `<@id>` written inside
 * message text or a fact. Reading them off the rendered document alone is not
 * enough: an author is a plain `authorId` field there, not a mention, so a
 * regex over the text would miss everybody who merely spoke.
 *
 * Anyone the material does not refer to is deliberately absent: telling the
 * model about somebody it has no other reason to know about is how it starts
 * volunteering things nobody asked.
 */
function usersInPlay(
  message: Message,
  windowMessages: WindowMessage[],
  promptText: string,
  ids: Iterable<string>,
): ContextUser[] {
  const selfId = message.client.user?.id;

  const byId = new Map<string, WindowMessage>();
  for (const windowMessage of windowMessages) {
    if (!windowMessage.isSelf) byId.set(windowMessage.authorId, windowMessage);
  }

  // Names for people who never spoke: the transcript annotates a mention as
  // `<@id>(Name)`, and the guild cache covers whoever that missed.
  const nameById = new Map<string, string>();
  for (const [id, user] of message.mentions.users) {
    nameById.set(id, message.mentions.members?.get(id)?.displayName ?? user.displayName ?? user.username);
  }
  for (const [, id, name] of promptText.matchAll(/<@!?(\d+)>\(([^)]*)\)/g)) {
    if (!nameById.has(id)) nameById.set(id, name);
  }

  const users: ContextUser[] = [];
  for (const id of new Set(ids)) {
    if (id === selfId) continue;

    const spoke = byId.get(id);
    const member = message.guild?.members.cache.get(id);
    const displayName = spoke?.displayName ?? nameById.get(id) ?? member?.displayName ?? member?.user.username ?? id;

    users.push({
      id,
      displayName,
      username: spoke?.authorUsername ?? member?.user.username ?? displayName,
      inConversation: spoke !== undefined,
      isTagger: id === message.author.id,
    });
  }

  return users;
}

/**
 * What the bot is allowed to ping, applied to every message it sends.
 *
 * The output sanitisers strip `<@id>` and `<#id>` the model was never given, but
 * they never touched `@everyone`, `@here` or a role mention `<@&id>` — nothing
 * matched those. The bot is told to do what people ask, so "say @everyone" was a
 * one-message server-wide ping, and a stored fact or a message from anyone at
 * all could have carried the same instruction.
 *
 * `parse: ['users']` is the hard stop: user mentions are already restricted to
 * ids the model was actually shown, and everyone/here/roles cannot ping at all
 * whatever ends up in the text. `repliedUser` keeps the ordinary Discord
 * behaviour of notifying whoever is being replied to.
 */
const ALLOWED_MENTIONS = { parse: ['users'], repliedUser: true } as const;

/** Mentioning half the server is not a question; two channels is already generous. */
const MAX_AUTOMATIC_CHANNEL_READS = 2;

/**
 * A channel named in the same breath as the ping is almost always what the
 * question is about — "what happened in #general" — so it is read without
 * anybody having to ask for it. discord.js has already resolved the `<#id>`
 * markup, so this only has to decide whether the bot is allowed in.
 */
async function readMentionedChannels(
  message: Message,
  guildId: string,
  limit: number,
  attachmentBudget: TextAttachmentBudget,
): Promise<ForeignChannelMessages[]> {
  if (limit <= 0) return [];

  const reads: ForeignChannelMessages[] = [];
  for (const channelId of message.mentions.channels.keys()) {
    if (channelId === message.channelId) continue;
    if (reads.length >= MAX_AUTOMATIC_CHANNEL_READS) break;

    const access = await resolveReadableChannel(message.client, guildId, channelId);
    if (!access.ok) {
      console.log(`[bot] not reading <#${channelId}>: ${access.reason}`);
      continue;
    }

    const messages = await fetchRecentMessages(access.channel, limit, attachmentBudget);
    if (messages.length === 0) continue;
    reads.push({ channelId, channelName: access.channel.name, messages });
    console.log(`[bot] read ${messages.length} message(s) from #${access.channel.name} for a mention`);
  }
  return reads;
}

export async function handleMention(message: Message): Promise<void> {
  const guildId = message.guildId;
  if (!guildId) return;

  const settings = getSettings();

  const release = admitReply(message.id, message.author.id, settings.rateLimitPerHour);
  if (!release) {
    await message.reply({ content: settings.rateLimitMessage, allowedMentions: ALLOWED_MENTIONS });
    return;
  }

  const stopTyping = startTyping(message);
  // Whether anything actually reached the channel. respond() sends the reply and
  // then writes to reply_log, so a failing write — or any bug after the send —
  // must not turn a delivered answer into an apology for failing.
  const outcome: ReplyOutcome = { replied: false };
  try {
    await withAIRequestBudget(() => respond(message, guildId, outcome));
  } catch (error) {
    // Which of these it was used to be unknowable from the channel, because all
    // three sent the same sentence. "I have no time" for a crash is how a bug
    // spent weeks looking like load.
    const { content, cause } = error instanceof BillingError
      ? { content: settings.noCreditsMessage, cause: 'the key cannot pay' }
      : error instanceof OverloadedError
        ? { content: settings.overloadMessage, cause: 'every chat model failed' }
        : error instanceof AIRequestBudgetError
          ? { content: settings.busyMessage, cause: 'ran out of reply budget' }
          : { content: settings.errorMessage, cause: 'unexpected error' };

    if (error instanceof OverloadedError || error instanceof AIRequestBudgetError || error instanceof BillingError) {
      console.warn(`[bot] not answering ${message.id} (${cause}): ${error.message}`);
    } else {
      console.error(`[bot] not answering ${message.id} (${cause}):`, error);
    }

    // Something did go out, so the failure is ours to read in the log rather
    // than a second message contradicting the first. Staying quiet instead
    // would be worse: going silent on somebody who asked a question is the
    // symptom the reply logging exists to make visible.
    if (!outcome.replied) {
      await message.reply({ content, allowedMentions: ALLOWED_MENTIONS }).catch(() => {});
    } else {
      console.warn(`[bot] ${message.id} already had a reply out, so nothing was sent about the ${cause}`);
    }
  } finally {
    stopTyping();
    release();
  }
}

/** Tracks whether the channel has already seen something, across a thrown error. */
interface ReplyOutcome {
  replied: boolean;
}

async function respond(message: Message, guildId: string, outcome: ReplyOutcome): Promise<void> {
  const settings = getSettings();
  const attachmentBudget = createTextAttachmentBudget();
  // None of these three depend on each other: working out the topic is a model
  // call, the quoted message is a Discord fetch, and a channel the ping pointed
  // at is another. Waiting for them one after another was pure latency.
  const [{ topic, windowMessages, discordMessages }, repliedTo, foreign] = await Promise.all([
    extractTopic(message, guildId, settings.replyContextMessages, attachmentBudget),
    // A reply can point at a message far outside the recent window, so it is
    // fetched rather than referred to by an id the model was never shown.
    message.type === MessageType.Reply && message.reference?.messageId
      ? message.fetchReference().catch(() => null)
      : Promise.resolve(null),
    readMentionedChannels(message, guildId, settings.crossChannelMessages, attachmentBudget),
  ]);

  // Whether to answer at all is the topic call's, as a field on its answer rather
  // than a tool the reply has to remember to call. Deciding it here means a reply
  // nobody wanted costs one model call instead of two, and the model that stays
  // quiet has no way to post the words "stay silent" by mistake.
  if (topic.staySilent) {
    console.log(`[bot] staying quiet on ${message.id} in #${message.channelId}: ${topic.whatTaggingMessageIsAbout || topic.coreTopic}`);
    await runAfterReply({ taggedMessage: message, sentMessageId: null, silent: true });
    return;
  }

  if (canExtractFrom(message.channelId)) cacheMessages(
    windowMessages
      .filter((windowMessage) => !windowMessage.isSelf)
      .map((windowMessage) => ({
        messageId: windowMessage.id,
        channelId: message.channelId,
        guildId,
        authorId: windowMessage.authorId,
        authorUsername: windowMessage.authorUsername,
        content: windowMessage.content,
        messageCreatedAt: windowMessage.createdAt,
      })),
  );

  // The topic call worked out what to look for and who and when it is about, so
  // recall matches the people and the days exactly and searches on the meaning
  // of the rest — rather than hoping an embedding noticed an id.
  const retrievedFacts = (await recallFacts({
    query: topic.searchQuery || topic.coreTopic,
    topK: settings.factSearchTopK,
    guildId,
    people: topic.people,
    channels: topic.channels,
    dateFrom: topic.dateFrom,
    dateTo: topic.dateTo,
  })).filter((fact) => canExtractFrom(fact.metadata.channelId));
  const sourceMessages = getMessages(retrievedFacts.flatMap((fact) => fact.metadata.messageIds))
    .filter((source) => source.guildId === guildId && canExtractFrom(source.channelId));

  const controller = isController(message.author.id);

  const quotedMessages = repliedTo && !windowMessages.some((item) => item.id === repliedTo.id)
    ? await windowMessagesWithAttachments([repliedTo], attachmentBudget) : [];
  if (canExtractFrom(message.channelId)) cacheMessages(quotedMessages.map((source) => ({
    messageId: source.id, guildId, channelId: message.channelId, authorId: source.authorId,
    authorUsername: source.authorUsername, content: source.content, messageCreatedAt: source.createdAt,
  })));
  const trigger = repliedTo
    ? repliedTo.author.id === message.client.user?.id ? 'replyToYou' : 'replyToOlderMessage'
    : 'mention';

  // Pictures come first: what could not be sent is marked in the transcript, so
  // a message whose whole content was an image does not read as blank.
  // A zero budget counts unseen images without downloading them.
  const { images, unseen } = await imagePartsFor(
    [...discordMessages, repliedTo], settings.visionEnabled ? settings.maxImages : 0,
  );
  const window = markUnseenImages(windowMessages, unseen);
  const quoted = markUnseenImages(quotedMessages, unseen);

  // Caching what another channel said is what lets the reply quote and link it.
  for (const read of foreign) {
    cacheMessages(
      read.messages.map((windowMessage) => ({
        messageId: windowMessage.id,
        channelId: read.channelId,
        guildId,
        authorId: windowMessage.authorId,
        authorUsername: windowMessage.authorUsername,
        content: windowMessage.content,
        messageCreatedAt: windowMessage.createdAt,
      })),
    );
  }

  // Without these ids the model has nothing to point read_channel at, and the
  // prompt forbids naming a channel whose id it was not given.
  const readableChannels = settings.crossChannelMessages > 0 && message.guild
    ? readableChannelRoster(message.guild)
    : [];
  const channelName = 'name' in message.channel ? message.channel.name : undefined;

  const material: Record<string, unknown> = {
    now: formatNow(settings.timezone),
    you: selfMaterial(message),
    channel: { id: message.channelId, ...(channelName ? { name: channelName } : {}) },
    trigger,
    requester: { id: message.author.id, name: message.author.username, isController: controller },
    whatIsBeingAsked: topic.whatTaggingMessageIsAbout,
    language: languageName(settings.replyLanguage),
    messages: messagesMaterial(window),
  };
  if (quoted.length > 0) material.quoted = messagesMaterial(quoted);
  if (images.length > 0) {
    material.images = images.map((image, index) => ({ index: index + 1, messageId: image.messageId }));
  }
  if (foreign.length > 0) {
    material.otherChannels = foreign.map((read) => ({
      id: read.channelId,
      name: read.channelName,
      messages: messagesMaterial(read.messages),
    }));
  }
  material.memory = { facts: factsMaterial(retrievedFacts, sourceMessages) };
  // The kinds of fact the operator has defined, and what each is for. Here
  // rather than in the prompt: an operator editing a description must not
  // invalidate the cached system prefix on every call.
  material.factTypes = factTypesForModel();
  if (readableChannels.length > 0) material.readableChannels = readableChannels;

  // Everyone the material actually refers to, read back out of it. Every
  // reference to a person reaches the model as `<@id>` — message authors,
  // mentions inside text, reply markers, fact text, the sources under a fact —
  // so the finished document names exactly the people it can see, with no
  // second list to keep in step.
  const materialText = renderMaterial(material);
  const people = usersInPlay(message, window, materialText, [
    // Written into the text: mentions inside messages, and inside facts.
    ...mentionedUserIds(materialText),
    // Carried structurally: whoever spoke, wherever they spoke.
    ...[...window, ...quoted, ...foreign.flatMap((read) => read.messages)]
      .filter((windowMessage) => !windowMessage.isSelf)
      .map((windowMessage) => windowMessage.authorId),
    ...sourceMessages.map((source) => source.authorId),
    message.author.id,
  ]);

  // Plugins get to annotate the people, messages and facts in play before the
  // material is sealed, so anything they know is simply present rather than
  // something the model has to think to ask for.
  const annotations = await collectAnnotations({
    taggedMessage: message,
    users: people,
    messages: window.map((windowMessage) => ({
      id: windowMessage.id,
      authorId: windowMessage.authorId,
      content: windowMessage.content,
      createdAt: windowMessage.createdAt,
    })),
    facts: retrievedFacts,
  });

  material.people = peopleMaterial(people, presenceFor(message, people.map((person) => person.id)));
  if (annotations) material.pluginNotes = [annotations];

  const pluginInstructions = await collectInstructions();
  const draft: DraftPrompt = {
    systemInstruction: [
      buildReplyInstruction(),
      ...pluginInstructions,
    ].join('\n\n'),
    material,
    images,
    retrievedFacts,
    sourceMessages,
  };

  const { draftPrompt, skipReply } = await runBeforeReply({ taggedMessage: message, draftPrompt: draft });
  if (skipReply) return;

  const reply = await generateReply(draftPrompt, {
    guildId,
    channelId: message.channelId,
    requesterIsController: controller,
    taggedMessage: message,
    windowMessages,
    foreignMessages: foreign,
    quotedMessages: quoted,
    attachmentBudget,
  });

  // Silence is a real outcome: nothing is sent and nothing is logged, since
  // reply_log records replies that actually happened.
  if (reply.silent) {
    await runAfterReply({ taggedMessage: message, sentMessageId: null, silent: true });
    return;
  }

  // Producing nothing is not the same thing, and folding the two together is
  // what made a bot that typed and then never answered impossible to spot.
  if (!reply.text) {
    console.warn(`[bot] no reply produced for message ${message.id} in #${message.channelId} — answering with the error message`);
    await message.reply({ content: settings.errorMessage, allowedMentions: ALLOWED_MENTIONS });
    outcome.replied = true;
    await runAfterReply({ taggedMessage: message, sentMessageId: null, silent: false });
    return;
  }

  // Every reply hangs under something. Normally the message that tagged the bot;
  // occasionally the one it is actually answering, when somebody pinged it into
  // a question another person asked. failIfNotExists keeps a deleted target from
  // swallowing the whole reply.
  const sent =
    reply.replyToMessageId && reply.replyToMessageId !== message.id && message.channel.isSendable()
      ? await message.channel.send({
          content: reply.text,
          reply: { messageReference: reply.replyToMessageId, failIfNotExists: false },
          allowedMentions: ALLOWED_MENTIONS,
        })
      : await message.reply({ content: reply.text, allowedMentions: ALLOWED_MENTIONS });
  outcome.replied = true;
  logReply({
    guildId,
    channelId: message.channelId,
    taggedMessageId: message.id,
    replyMessageId: sent.id,
    userId: message.author.id,
    content: reply.text,
    factIdsUsed: [...retrievedFacts.map((fact) => fact.id), ...reply.savedFactIds, ...reply.deletedFactIds],
  });

  // Last, with the answer already in the channel: whatever a plugin does here,
  // nobody is waiting through it.
  await runAfterReply({ taggedMessage: message, sentMessageId: sent.id, silent: false });
}
