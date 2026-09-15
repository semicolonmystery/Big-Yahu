/**
 * What kind of thing a fact is.
 *
 * A type is a search facet the model can aim at: "rules about X" rather than
 * "anything like X". That only works if the model can tell the types apart, so
 * each carries a description written *at the model* — it is what it reads to
 * sort a fact on the way in and to pick a type on the way out, and it travels in
 * the JSON material rather than the system prompt, so editing one never breaks
 * the cached prefix.
 *
 * A fact carries **several** types. Nearly anything that says something also
 * gets `message`, so one record answers both "what did we agree" and "who said
 * that" instead of the store holding two copies of the same sentence.
 *
 * The operator owns the list: these seven ship, and more can be added in
 * Settings. Each type also carries its own copy of the three fact settings,
 * because what counts as a duplicate of a one-line message record is not what
 * counts as a duplicate of a rule.
 */
export interface FactType {
  id: string;
  label: string;
  /** Read by the model. Says what belongs here and what to search it for. */
  description: string;
  sortOrder: number;
  /** Shipped with the bot, so Settings can offer to put it back as it was. */
  builtIn: boolean;
  /** Hundredths of a vector distance. 0 means never merge two facts of this type. */
  duplicateDistance: number;
  factSearchTopK: number;
  /** Hundredths of a vector distance. 0 switches the ceiling off. */
  factSearchMaxDistance: number;
}

export interface BuiltInFactType {
  id: string;
  label: string;
  description: string;
  /** Where a shipped type wants something other than the global setting. */
  overrides?: Partial<Pick<FactType, 'duplicateDistance' | 'factSearchTopK' | 'factSearchMaxDistance'>>;
}

export const BUILT_IN_FACT_TYPES: readonly BuiltInFactType[] = [
  {
    id: 'rule',
    label: 'Rule',
    description: 'A standing instruction or convention that keeps applying until somebody changes it — how things '
      + 'are done here, what is allowed, what the bot itself is meant to do. Not a one-off outcome. Search this when '
      + 'somebody asks what the rule is, whether something is allowed, or how something is normally done.',
  },
  {
    id: 'person',
    label: 'Person',
    description: 'A durable attribute of one member: what they do, what they play, their setup, their role here, '
      + 'what they are called. Not what they think of something, and not a one-off thing they did. Search this when '
      + 'the question is about who somebody is.',
  },
  {
    id: 'preference',
    label: 'Preference',
    description: 'Something somebody likes, dislikes or holds an opinion about. Attached to the person who holds '
      + 'it. Search this when the question is what somebody thinks of something, or what they would want.',
  },
  {
    id: 'event',
    label: 'Event',
    description: 'Something that happened, or is going to happen, at a particular time. Carries a date whenever the '
      + 'messages give one. Search this when the question is about when something happened or what happened on a day.',
  },
  {
    id: 'decision',
    label: 'Decision',
    description: 'An outcome the group settled on — a roster, a name, a plan, a choice between options. Distinct '
      + 'from a rule: a decision is one settled thing, a rule keeps applying. Search this when the question is what '
      + 'was agreed.',
  },
  {
    id: 'message',
    label: 'Message',
    description: 'A near-verbatim record of something somebody said, kept so it can be recalled later as having '
      + 'been said. This is the broad one: almost every message that carries any information at all gets one, on top '
      + 'of whatever else it is. Skip only what carries nothing — greetings, goodbyes, "lol", bare insults, '
      + 'reactions. Search this when somebody asks who said something, what somebody said about a subject, or what '
      + 'was said at some point.',
    // Message records are short, numerous and often near-identical: two people
    // saying much the same thing on different days is exactly the shape that
    // merges wrongly, and a merge overwrites the older wording. 0 is off.
    overrides: { duplicateDistance: 0, factSearchTopK: 12 },
  },
  {
    id: 'info',
    label: 'Info',
    description: 'Anything true about this server or the people in it that none of the others fit. The fallback, '
      + 'not the default — prefer a specific type whenever one applies. Search this when nothing more specific '
      + 'matches the question.',
  },
];

/** Slugs an operator may invent: the shape a Chroma metadata value and a schema enum both tolerate. */
export const FACT_TYPE_ID = /^[a-z][a-z0-9_-]{0,30}$/;

/**
 * "Search everything", as a value the model can actually send.
 *
 * It used to be the empty string, which Google's API rejects outright — *"enum[0]:
 * cannot be empty"* — and took down every reply the moment the bot moved onto a
 * Gemini endpoint. An enum member has to be a real word, so this is one, and it
 * is reserved: a type an operator names `any` would mean two things at once.
 */
export const ANY_FACT_TYPE = 'any';

export const FACT_TYPE_LABEL_MAX = 60;
export const FACT_TYPE_DESCRIPTION_MAX = 2000;
/** More than this and the model is choosing from a catalogue rather than a list. */
export const FACT_TYPES_MAX = 24;
