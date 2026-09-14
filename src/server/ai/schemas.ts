import type { ToolDeclaration } from './chat';
import type { JsonSchema } from './jsonSchema';

/**
 * The shapes of the structured answers, as plain JSON Schema. Every property is
 * required and nothing else is allowed; a field with nothing to say is an empty
 * string or an empty list, never missing. The descriptions are the instructions
 * the model reads for each field, so they carry the rules, not just the type.
 */
/**
 * What a fact is, as the model must answer it.
 *
 * The type list is not a constant, because an operator owns it: the enum is
 * built from `fact_types` per call. That does change the schema message a
 * structured call sends, which costs the same as toggling a plugin — worth it,
 * since an enum is the difference between the model choosing from the list and
 * inventing a type nobody defined.
 */
const typesField = (typeIds: string[]): JsonSchema => ({
  type: 'array',
  items: typeIds.length > 0 ? { type: 'string', enum: typeIds } : { type: 'string' },
  description:
    'What kinds of thing this fact is, from the `factTypes` list you were given — several, not one. '
    + 'Nearly anything that says something is also "message", on top of whatever else it is: that is what '
    + 'makes it findable later as something somebody said. Read each type\'s description and pick every '
    + 'one that genuinely applies.',
});

const factList = (typeIds: string[]): JsonSchema => ({
  type: 'array',
  description: 'The facts worth remembering. An empty array is a perfectly good answer.',
  items: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description:
          'The fact, stated so it still makes sense months later. Always in English. Name people by their '
          + '<@ID> mention rather than their display name. Write dates absolutely — never "tomorrow" or '
          + '"zítra", always the real date worked out from the message timestamp, and always as '
          + 'day.month.year: "10.9.2026 21:00", never 9/10/2026 and never 2026-09-10. '
          + 'Only say when something happened or was said if the messages actually say when — if nobody said, '
          + 'write the fact with no date at all rather than guessing one. '
          + 'Put anything whose exact wording is the point — a nickname, a quoted phrase — in double quotes, '
          + 'and it is kept verbatim.',
      },
      types: typesField(typeIds),
      messageIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'IDs of the messages this fact came from. Copy them exactly.',
      },
    },
    required: ['text', 'types', 'messageIds'],
    additionalProperties: false,
  },
});

export const extractionSchemaFor = (typeIds: string[]): JsonSchema => ({
  type: 'object',
  properties: {
    facts: factList(typeIds),
    needsMoreContext: {
      type: 'boolean',
      description: 'True only if earlier conversation is genuinely required to understand these messages.',
    },
    contextHint: {
      type: 'string',
      description:
        'When asking for more context, what is missing, so the right history can be found. Name anyone '
        + 'involved both ways: their name and their <@ID> mention. Empty when nothing is missing.',
    },
  },
  required: ['facts', 'needsMoreContext', 'contextHint'],
  additionalProperties: false,
});

const DAY_MONTH_YEAR = '^(\\d{1,2}\\.\\d{1,2}\\.\\d{4})?$';

export const topicSchema: JsonSchema = {
  type: 'object',
  properties: {
    coreTopic: {
      type: 'string',
      description:
        'What this conversation is about, in one or two sentences. Name anyone involved both ways: their '
        + 'name and their <@ID> mention.',
    },
    whatTaggingMessageIsAbout: {
      type: 'string',
      description:
        'What the person who tagged the bot is actually asking for. Name anyone involved both ways: '
        + 'their name and their <@ID> mention.',
    },
    searchQuery: {
      type: 'string',
      description:
        'What to search stored memory for, written the way a stored fact is written: one or two plain '
        + 'statements of the thing being looked for, never a question, in English. Keep every name, place and '
        + 'specific term exactly as written; they carry most of the meaning. Leave mentions and dates out of it — '
        + 'they go in people, channels, dateFrom and dateTo. Add nothing that was not asked for, and do not '
        + 'answer the question.',
    },
    people: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The Discord user ids of everyone the question is about: the digits from their <@ID> mention. '
        + 'Empty when it is about nobody in particular.',
    },
    channels: {
      type: 'array',
      items: { type: 'string' },
      description: 'The ids of any channels the question is about: the digits from <#ID>. Empty when none.',
    },
    dateFrom: {
      type: 'string',
      pattern: DAY_MONTH_YEAR,
      description:
        'When the question is about a particular time, its first day as day.month.year, like "3.10.2026", '
        + 'worked out from the message timestamps. Empty otherwise.',
    },
    dateTo: {
      type: 'string',
      pattern: DAY_MONTH_YEAR,
      description: 'The last day of that time, as day.month.year. The same as dateFrom for a single day. Empty otherwise.',
    },
    staySilent: {
      type: 'boolean',
      description:
        'True to send no reply at all, and nothing else happens. Set it only when answering would just feed '
        + 'something pointless: somebody fishing for a reaction, a slanging match that has stopped going '
        + 'anywhere, or somebody needling the bot about whether it will respond. A real question always gets '
        + 'an answer, and a bare mention is almost never noise — people split the ping from the message, or '
        + 'what they want is in the lines just above. False in every other case.',
    },
    needsMoreContext: {
      type: 'boolean',
      description: 'True only if earlier conversation is genuinely required to work out what is being asked.',
    },
    contextHint: {
      type: 'string',
      description:
        'What is missing, naming anyone involved by both their name and their <@ID> mention. Empty when '
        + 'nothing is missing.',
    },
  },
  required: [
    'coreTopic', 'whatTaggingMessageIsAbout', 'searchQuery', 'people', 'channels', 'dateFrom', 'dateTo',
    'staySilent', 'needsMoreContext', 'contextHint',
  ],
  additionalProperties: false,
};

export interface ExtractedFact {
  text: string;
  /** Validated against the live list on the way in: a type nobody defined is dropped. */
  types: string[];
  messageIds: string[];
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  needsMoreContext: boolean;
  contextHint: string;
}

export interface TopicResult {
  coreTopic: string;
  whatTaggingMessageIsAbout: string;
  searchQuery: string;
  people: string[];
  channels: string[];
  dateFrom: string;
  dateTo: string;
  /** Send nothing at all. Decided here, as a field, rather than by the reply calling a tool. */
  staySilent: boolean;
  needsMoreContext: boolean;
  contextHint: string;
}

export const requestMoreContextDeclaration: ToolDeclaration = {
  name: 'request_more_context',
  description:
    'Ask for older messages from this channel and more stored facts before you answer. ' +
    'Call this when the question depends on something said earlier than what you can see. ' +
    'Never guess at what someone said — if it is not in front of you, ask for more or say you do not have it.',
  parameters: {
    type: 'object',
    properties: {
      lookingFor: {
        type: 'string',
        description:
          'What you need to find, written the way a stored fact would say it: a plain statement, not a '
          + 'question, like "Someone <@123456> said something about the trip". It is used to search stored facts. '
          + 'Name every person both ways — their name as people say it and their <@ID> mention. Stored facts '
          + 'refer to people by ID, while the conversation refers to them by name, so a search carrying only one '
          + 'of the two finds half of what is there.',
      },
      people: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The Discord ids of anyone it is about — the digits from their <@ID> mention. Memory knows who each '
          + 'fact concerns, so naming them here finds what is about them even when the wording differs.',
      },
    },
    required: ['lookingFor'],
  },
};

export const listPeopleDeclaration: ToolDeclaration = {
  name: 'list_people',
  description:
    'List the people in this server the bot can currently see, with what each of them is doing right now. '
    + 'Call this when you are asked about somebody who is not in the conversation in front of you — who they '
    + 'are, whether they are around, what they are playing — or when you need the id behind a name someone '
    + 'typed as plain text. It does not read messages and cannot tell you what anyone said; for that, use '
    + 'request_more_context instead. The list is everyone visible, not the full membership, so somebody '
    + 'missing from it is not proof they are not in the server.',
  parameters: {
    type: 'object',
    properties: {
      nameContains: {
        type: 'string',
        description:
          'Narrow the list to names containing this, when you are after one person. '
          + 'Leave it out to see everybody.',
      },
    },
  },
};

export const readChannelDeclaration: ToolDeclaration = {
  name: 'read_channel',
  description:
    'Read the recent messages of another channel in this server. Reach for it when what you are asked '
    + 'about happened somewhere else — somebody points at a channel, or asks what is going on in one. '
    + 'Only pass a channel id you were actually given; the channels you may read are listed for you. '
    + 'For older messages in the channel you are already in, use request_more_context instead.',
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'The channel id — the digits out of its <#id> mention, nothing else.',
      },
      lookingFor: {
        type: 'string',
        description:
          'What you are after in there, written as a plain statement rather than a question. Also used to '
          + 'search what you remember about that channel. Name people both ways, their name and their <@ID> mention.',
      },
      people: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The Discord ids of anyone it is about — the digits from their <@ID> mention. Memory knows who each '
          + 'fact concerns, so naming them here finds what is about them even when the wording differs.',
      },
    },
    required: ['channelId'],
  },
};

export const replyToDeclaration: ToolDeclaration = {
  name: 'reply_to',
  description:
    'Attach your reply to a different message than the one that tagged you. You always reply to something, '
    + 'and by default it is the message that pinged you — you do not need this to do the normal thing. '
    + 'Use it when the message that pinged you is not the one you are answering: somebody pulled you into '
    + 'a question another person asked and forgot to tag you in, so your answer belongs under theirs. '
    + 'Only pass a message id from this channel that you were actually shown.',
  parameters: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'The [id=...] of the message you are actually answering, exactly as it was given to you.',
      },
      why: { type: 'string', description: 'One short line, for the logs. Nobody in the chat sees this.' },
    },
    required: ['messageId'],
  },
};

export const deleteFactDeclaration: ToolDeclaration = {
  name: 'delete_fact',
  description:
    'Forget a stored fact permanently. Use it when a fact you were given is genuinely out of date or wrong: '
    + 'superseded by newer information, retracted, or the situation changed. When you know the corrected version, '
    + 'call save_fact as well so the memory is replaced rather than just emptied. '
    + 'Do not delete because someone dislikes a fact or simply asked you to. Only ever pass an id you were shown.',
  parameters: {
    type: 'object',
    properties: {
      factId: { type: 'string', description: 'The factId of the fact to forget, exactly as given to you.' },
      why: { type: 'string', description: 'One short line on why it is going, for the logs.' },
    },
    required: ['factId', 'why'],
  },
};

export const saveFactDeclarationFor = (typeIds: string[]): ToolDeclaration => ({
  name: 'save_fact',
  description:
    'Store something from your reply as a durable fact, so it can be recalled in future conversations. ' +
    'Only call this when your reply contains information worth remembering later — not for small talk. ' +
    'The fact is always written in English, whatever language you are replying in, and names people by ' +
    'their <@ID> mention rather than by a display name that will change.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description:
          'The fact to remember, phrased to stand on its own, in English. Refer to people as <@ID>. '
          + 'Write dates absolutely — never "tomorrow" or "zítra", always the real date worked out from '
          + 'the current time and the message it came from, and always as day.month.year: '
          + '"10.9.2026 21:00", never 9/10/2026 and never 2026-09-10. '
          + 'Only say when something happened or was said if the messages actually say when — if nobody '
          + 'said, write the fact with no date at all rather than guessing one. '
          + 'Wording that matters — a nickname, a phrase someone actually used — goes in double quotes '
          + 'and is kept exactly, in whatever language it was said.',
      },
      types: typesField(typeIds),
      referencedFactIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'IDs of existing facts this one builds on, if any were provided to you.',
      },
    },
    required: ['text', 'types'],
  },
});
