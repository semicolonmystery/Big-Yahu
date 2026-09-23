import type { ToolDeclaration } from './chat';
import type { JsonSchema } from './jsonSchema';
import { ANY_FACT_TYPE } from '@shared/factTypes';

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

/** More searches than this in one call is a fishing expedition, not a question. */
export const MAX_TOPIC_SEARCHES = 4;

/**
 * One thing to look for in memory.
 *
 * The topic call used to produce exactly one of these, so a reply got one
 * recall — which meant a question touching two people and a rule had to be
 * flattened into a single embedding and hope. Several searches cost several
 * embeddings and no extra chat calls, because `embedWith` takes an array.
 */
const searchShape = (typeIds: string[]): JsonSchema => ({
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'What to search for, written the way a stored fact is written: one or two plain statements of the '
        + 'thing being looked for, never a question, in English. Keep every name, place and specific term '
        + 'exactly as written; they carry most of the meaning. Leave mentions and dates out of it — they go in '
        + 'people, channels, dateFrom and dateTo. Add nothing that was not asked for, and never answer the question.',
    },
    type: {
      type: 'string',
      ...(typeIds.length > 0 ? { enum: [ANY_FACT_TYPE, ...typeIds] } : {}),
      description:
        'Which kind of fact to search, from the `factTypes` list you were given — read what each one says it '
        + 'is for. A search naming a type returns only that kind, which is the point: asking for "message" '
        + 'finds what somebody said, asking for "rule" finds what the rule is, and neither buries the other. '
        + `Use "${ANY_FACT_TYPE}" to search everything at once, which is right when the question fits no one kind.`,
    },
    people: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The Discord user ids this search is about: the digits from their <@ID> mention. Empty when it is '
        + 'about nobody in particular.',
    },
    channels: {
      type: 'array',
      items: { type: 'string' },
      description: 'The ids of any channels this search is about: the digits from <#ID>. Empty when none.',
    },
    dateFrom: {
      type: 'string',
      pattern: DAY_MONTH_YEAR,
      description:
        'When this search is about a particular time, its first day as day.month.year, like "3.10.2026", '
        + 'worked out from the message timestamps. Empty otherwise.',
    },
    dateTo: {
      type: 'string',
      pattern: DAY_MONTH_YEAR,
      description: 'The last day of that time, as day.month.year. The same as dateFrom for a single day. Empty otherwise.',
    },
  },
  required: ['query', 'type', 'people', 'channels', 'dateFrom', 'dateTo'],
  additionalProperties: false,
});

export const topicSchemaFor = (typeIds: string[]): JsonSchema => ({
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
    searches: {
      type: 'array',
      items: searchShape(typeIds),
      description:
        `Everything worth looking up before answering, as separate searches — at most ${MAX_TOPIC_SEARCHES}, and `
        + 'anything past that is dropped. Split the question rather than flattening it: one search per person '
        + 'it is about, and a separate one per kind of fact, so "what did Alice and Bob say about the server '
        + 'rules" is a message search naming Alice, a message search naming Bob, and a rule search about the '
        + 'server. They are all run, and the bot is given everything they find. An empty array is right only '
        + 'when nothing needs remembering at all.',
    },
    staySilent: {
      type: 'boolean',
      description:
        'True to send no reply at all. Answering is the default and this is rare — two things earn it: a '
        + 'message whose whole point is getting a reply at all, where any answer is the win and there is '
        + 'nothing in it to actually answer, or a person the bot has already said it is finished with. '
        + 'Nothing else does. An acknowledgement or a thanks is still somebody talking to the bot and gets a '
        + 'brief answer back, unless the same one keeps coming with nothing new in any of it — and anything '
        + 'else riding along with it is answered on the strength of that. Somebody repeating themselves or '
        + 'getting annoyed that nothing came back means the last thing they said needed an answer and did not '
        + 'get one, so answer them.',
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
  required: ['coreTopic', 'whatTaggingMessageIsAbout', 'searches', 'staySilent', 'needsMoreContext', 'contextHint'],
  additionalProperties: false,
});

/** One search as the model asked for it, before the host bounds it. */
export interface FactSearch {
  query: string;
  type: string;
  people: string[];
  channels: string[];
  dateFrom: string;
  dateTo: string;
}

export interface TopicResult {
  coreTopic: string;
  whatTaggingMessageIsAbout: string;
  searches: FactSearch[];
  /** Send nothing at all. Decided here, as a field, rather than by the reply calling a tool. */
  staySilent: boolean;
  needsMoreContext: boolean;
  contextHint: string;
}

/**
 * What the cleanup pass answers with: one entry per fact it was handed, keyed by
 * the id it came in with. `changed` is the honest majority answer — a fact that
 * was already right is returned untouched, and the host writes nothing for it.
 */
export const cleanupSchemaFor = (typeIds: string[]): JsonSchema => ({
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      description: 'One entry per fact you were given, no more and no fewer, each keyed by the id it came with.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id of the fact this is, copied exactly from what you were given.' },
          text: {
            type: 'string',
            description:
              'The fact, corrected where a rule was broken and returned word for word where it was not. '
              + 'Never reword for style. Never invent anything that is not in the fact or its sources.',
          },
          types: typesField(typeIds),
          changed: {
            type: 'boolean',
            description:
              'True only if you actually altered the wording or the types. False is the right answer for most '
              + 'facts, and is not a failure.',
          },
          needsSources: {
            type: 'boolean',
            description:
              'True if you cannot judge this one without seeing the messages it came from — usually a date or '
              + 'a name that the text alone cannot resolve. Return it unchanged for now; you will be asked '
              + 'again with its sources. Only where it would actually decide something.',
          },
        },
        required: ['id', 'text', 'types', 'changed', 'needsSources'],
        additionalProperties: false,
      },
    },
  },
  required: ['facts'],
  additionalProperties: false,
});

export interface CleanedFact {
  id: string;
  text: string;
  types: string[];
  changed: boolean;
  needsSources: boolean;
}

export interface CleanupResult {
  facts: CleanedFact[];
}

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


export const readHistoryDeclaration: ToolDeclaration = {
  name: 'read_history',
  description:
    'Read older messages from this channel, further back than the ones you can see. ' +
    'Call this when the question depends on something said earlier than your window. ' +
    'It reads messages and nothing else — to look something up in memory, use search_facts. ' +
    'Never guess at what someone said: if it is not in front of you, read further back or say you do not have it.',
  parameters: {
    type: 'object',
    properties: {
      lookingFor: {
        type: 'string',
        description: 'What you are hoping to find back there, in one short line. For the logs; it does not filter anything.',
      },
    },
    required: ['lookingFor'],
  },
};

export const searchFactsDeclarationFor = (typeIds: string[]): ToolDeclaration => ({
  name: 'search_facts',
  description:
    'Look things up in your memory. Give every search you want in one call — they all run and you get ' +
    'everything they find, so asking for three things at once costs no more round trips than asking for one. ' +
    'Use it when what you were handed does not cover the question. It searches stored facts, not messages: ' +
    'for older messages in this channel use read_history.',
  parameters: {
    type: 'object',
    properties: {
      searches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'What to find, written the way a stored fact would say it: a plain statement, not a question, '
                + 'like "Someone <@123456> said something about the trip". Name every person both ways — their '
                + 'name as people say it and their <@ID> mention. Stored facts refer to people by ID while the '
                + 'conversation refers to them by name, so a search carrying only one of the two finds half of '
                + 'what is there.',
            },
            type: {
              type: 'string',
              ...(typeIds.length > 0 ? { enum: [ANY_FACT_TYPE, ...typeIds] } : {}),
              description:
                'Which kind of fact to look in, from the `factTypes` list you were given. A search naming a '
                + 'type returns only that kind, which is how asking for a rule does not come back as eight '
                + `things somebody said. "${ANY_FACT_TYPE}" searches everything.`,
            },
            people: {
              type: 'array',
              items: { type: 'string' },
              description:
                'The Discord ids this search is about — the digits from their <@ID> mention. Memory knows who '
                + 'each fact concerns, so naming them finds what is about them even when the wording differs.',
            },
          },
          required: ['query', 'type', 'people'],
          additionalProperties: false,
        },
        description: `The searches to run, at most ${MAX_TOPIC_SEARCHES}. Split the question rather than flattening it: `
          + 'one per person it is about, and a separate one per kind of fact.',
      },
    },
    required: ['searches'],
  },
});


export const seeImageDeclaration: ToolDeclaration = {
  name: 'see_image',
  description:
    'Look at a picture you were not sent. A message marked with `unseenImages` had pictures that did not fit '
    + "the call's budget, so you cannot see them — call this with that message's id and they are shown to you. "
    + 'Use it when somebody is talking about a picture you have not been given and the answer depends on what '
    + 'is in it. Never guess at what a picture you have not seen contains.',
  parameters: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'The id of the message whose pictures you want, exactly as it appears in the material.',
      },
    },
    required: ['messageId'],
  },
};

export const listPeopleDeclaration: ToolDeclaration = {
  name: 'list_people',
  description:
    'List the people in this server the bot can currently see, with what each of them is doing right now. '
    + 'Call this when you are asked about somebody who is not in the conversation in front of you — who they '
    + 'are, whether they are around, what they are playing — or when you need the id behind a name someone '
    + 'typed as plain text. It does not read messages and cannot tell you what anyone said; for that, use '
    + 'read_history or search_facts instead. The list is everyone visible, not the full membership, so somebody '
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
    + 'For older messages in the channel you are already in, use read_history instead.',
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
    + 'Anybody can tell you a fact is wrong, not only a controller, but being told is not the same as it being '
    + 'so: the reason has to hold up, either because they say what the truth is now or because the conversation '
    + 'bears it out. A controller asking is enough on its own. Never delete because somebody dislikes a fact. '
    + 'Only ever pass an id you were shown.',
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
