import { Type } from '@google/genai';
import type { FunctionDeclaration, Schema } from '@google/genai';

const factListSchema: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      text: {
        type: Type.STRING,
        description:
          'The fact, stated so it still makes sense months later. Always in English. Name people by their '
          + '<@ID> mention rather than their display name. Write dates absolutely — never "tomorrow" or '
          + '"zítra", always the real date worked out from the message timestamp, and always as '
          + 'day.month.year: "10.9.2026 21:00", never 9/10/2026 and never 2026-09-10. '
          + 'Put anything whose exact wording is the point — a nickname, a quoted phrase — in double quotes, '
          + 'and it is kept verbatim.',
      },
      messageIds: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'IDs of the messages this fact came from. Copy them exactly.',
      },
    },
    required: ['text', 'messageIds'],
  },
};

export const extractionSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    facts: factListSchema,
    needsMoreContext: {
      type: Type.BOOLEAN,
      description: 'True only if earlier conversation is genuinely required to understand these messages.',
    },
    contextHint: {
      type: Type.STRING,
      description:
        'When asking for more context, describe what is missing so the right history can be found. '
        + 'Name anyone involved both ways: their name and their <@ID> mention.',
    },
  },
  required: ['facts', 'needsMoreContext'],
};

export const topicSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    coreTopic: {
      type: Type.STRING,
      description:
        'What this conversation is about, in one or two sentences. These words are used to search stored '
        + 'memory, so name anyone involved both ways: their name and their <@ID> mention.',
    },
    whatTaggingMessageIsAbout: {
      type: Type.STRING,
      description:
        'What the person who tagged the bot is actually asking for. Name anyone involved both ways: '
        + 'their name and their <@ID> mention.',
    },
    facts: factListSchema,
    needsMoreContext: { type: Type.BOOLEAN },
    contextHint: {
      type: Type.STRING,
      description: 'What is missing, naming anyone involved by both their name and their <@ID> mention.',
    },
  },
  required: ['coreTopic', 'whatTaggingMessageIsAbout', 'facts', 'needsMoreContext'],
};

export interface ExtractedFact {
  text: string;
  messageIds: string[];
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  needsMoreContext: boolean;
  contextHint?: string;
}

export interface TopicResult extends ExtractionResult {
  coreTopic: string;
  whatTaggingMessageIsAbout: string;
}

export const requestMoreContextDeclaration: FunctionDeclaration = {
  name: 'request_more_context',
  description:
    'Ask for older messages from this channel and more stored facts before you answer. ' +
    'Call this when the question depends on something said earlier than what you can see. ' +
    'Never guess at what someone said — if it is not in front of you, ask for more or say you do not have it.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      lookingFor: {
        type: 'string',
        description:
          'What you need to find, in a sentence. Used to search stored facts. '
          + 'Name every person both ways — their name as people say it and their <@ID> mention, like '
          + '"what Someone <@123456> said about the trip". Stored facts refer to people by ID, while the '
          + 'conversation refers to them by name, so a search carrying only one of the two finds half of what is there.',
      },
    },
    required: ['lookingFor'],
  },
};

export const listPeopleDeclaration: FunctionDeclaration = {
  name: 'list_people',
  description:
    'List the people in this server the bot can currently see, with what each of them is doing right now. '
    + 'Call this when you are asked about somebody who is not in the conversation in front of you — who they '
    + 'are, whether they are around, what they are playing — or when you need the id behind a name someone '
    + 'typed as plain text. It does not read messages and cannot tell you what anyone said; for that, use '
    + 'request_more_context instead. The list is everyone visible, not the full membership, so somebody '
    + 'missing from it is not proof they are not in the server.',
  parametersJsonSchema: {
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

export const readChannelDeclaration: FunctionDeclaration = {
  name: 'read_channel',
  description:
    'Read the recent messages of another channel in this server. Reach for it when what you are asked '
    + 'about happened somewhere else — somebody points at a channel, or asks what is going on in one. '
    + 'Only pass a channel id you were actually given; the channels you may read are listed for you. '
    + 'For older messages in the channel you are already in, use request_more_context instead.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'The channel id — the digits out of its <#id> mention, nothing else.',
      },
      lookingFor: {
        type: 'string',
        description:
          'What you are after in there, in a sentence. Also used to search what you remember about that '
          + 'channel. Name people both ways, their name and their <@ID> mention.',
      },
    },
    required: ['channelId'],
  },
};

export const replyToDeclaration: FunctionDeclaration = {
  name: 'reply_to',
  description:
    'Attach your reply to a different message than the one that tagged you. You always reply to something, '
    + 'and by default it is the message that pinged you — you do not need this to do the normal thing. '
    + 'Use it when the message that pinged you is not the one you are answering: somebody pulled you into '
    + 'a question another person asked and forgot to tag you in, so your answer belongs under theirs. '
    + 'Only pass a message id from this channel that you were actually shown.',
  parametersJsonSchema: {
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

export const deleteFactDeclaration: FunctionDeclaration = {
  name: 'delete_fact',
  description:
    'Forget a stored fact permanently. Use it when a fact you were given is genuinely out of date or wrong: '
    + 'superseded by newer information, retracted, or the situation changed. When you know the corrected version, '
    + 'call save_fact as well so the memory is replaced rather than just emptied. '
    + 'Do not delete because someone dislikes a fact or simply asked you to. Only ever pass an id you were shown.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      factId: { type: 'string', description: 'The factId of the fact to forget, exactly as given to you.' },
      why: { type: 'string', description: 'One short line on why it is going, for the logs.' },
    },
    required: ['factId', 'why'],
  },
};

export const staySilentDeclaration: FunctionDeclaration = {
  name: 'stay_silent',
  description:
    'Say nothing at all. No message is sent. Use this when replying would only feed something pointless: '
    + 'someone baiting you for a reaction, or a slanging match that is going nowhere. '
    + 'If you have already said you are done with someone, this is how you actually be done. '
    + 'Do not use it just because a message is short or has no question in it — read the conversation first.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      why: { type: 'string', description: 'One short line, for the logs. Nobody in the chat sees this.' },
    },
    required: ['why'],
  },
};

export const saveFactDeclaration: FunctionDeclaration = {
  name: 'save_fact',
  description:
    'Store something from your reply as a durable fact, so it can be recalled in future conversations. ' +
    'Only call this when your reply contains information worth remembering later — not for small talk. ' +
    'The fact is always written in English, whatever language you are replying in, and names people by ' +
    'their <@ID> mention rather than by a display name that will change.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description:
          'The fact to remember, phrased to stand on its own, in English. Refer to people as <@ID>. '
          + 'Write dates absolutely — never "tomorrow" or "zítra", always the real date worked out from '
          + 'the current time and the message it came from, and always as day.month.year: '
          + '"10.9.2026 21:00", never 9/10/2026 and never 2026-09-10. '
          + 'Wording that matters — a nickname, a phrase someone actually used — goes in double quotes '
          + 'and is kept exactly, in whatever language it was said.',
      },
      referencedFactIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'IDs of existing facts this one builds on, if any were provided to you.',
      },
    },
    required: ['text'],
  },
};
