/**
 * Deciding whether a fact still carries a relative date, from text written by
 * people who do not punctuate, do not accent, and do not spell.
 *
 * The first pass was a list of literal regexes against the raw text, which meant
 * `zítra` was caught and `zitra` was not, `zejtra` was caught and `zejtra v 9`
 * typed as `zejta` was not. Anything expected to survive real chat has to fold
 * the text down first and match loosely on top of it.
 */

const COMBINING_MARKS = /[\u0300-\u036f]/g;

function deaccent(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
}

/** Lowercased, unaccented, punctuation reduced to spaces. `Zitra!!` and `zitra` become one thing. */
export function normalise(text: string): string {
  return deaccent(text).replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The same fold, but keeping the marks that hold a date together. Flattening
 * everything turns `12.9.2026` into three loose numbers, and then a sentence
 * that had already been resolved looks exactly like one that never was.
 */
function foldKeepingDateMarks(text: string): string {
  return deaccent(text).replace(/[^a-z0-9./-]+/g, ' ').trim();
}

/** Bounded Levenshtein: it only ever has to answer "within k?", so it can stop early. */
function withinDistance(a: string, b: string, k: number): boolean {
  if (Math.abs(a.length - b.length) > k) return false;
  if (a === b) return true;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    if (best > k) return false;
    previous = current;
  }
  return previous[b.length] <= k;
}

/**
 * Slavic words inflect at the end — zítra, zítřejší, zejtra; včera, včerejší —
 * so the front of the word is the reliable part. A stem match is what catches
 * the inflections a word list never will.
 */
const RELATIVE_STEMS = [
  'zitr', 'zejtr', 'zitre', 'zejtre',
  'vcer', 'vcerej',
  'pozitr', 'pozejtr', 'pozajtr',
  'predevcir', 'predvcer',
  'zajtr', 'zajtre',
  'dnesk', 'dnesn', 'dnesny',
];

/** Words that do not inflect, so a typo is the only thing to allow for. */
const RELATIVE_WORDS = [
  'today', 'tonight', 'tomorrow', 'yesterday', 'tmrw', 'tmrrw',
  'dnes', 'zitra', 'zejtra', 'vcera', 'zajtra',
];

/**
 * Phrases, matched against the folded text so spacing and punctuation stop
 * mattering. Weekday names appear here only with something in front of them:
 * "next friday" is relative, and a bare "friday" is handled below.
 */
const WEEKDAY = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday'
  + '|pondeli|utery|stredu|streda|ctvrtek|patek|sobota|sobotu|nedeli|nedele'
  + '|pondelok|utorok|stvrtok|piatok|nedelu';

const RELATIVE_PHRASES = [
  new RegExp(`\\b(?:next|last|this|coming|following) (?:week|month|year|weekend|${WEEKDAY})\\b`),
  /\b(?:in|within) (?:a|an|another|\d+) (?:minute|hour|day|week|month|year)s?\b/,
  /\b(?:\d+ )?(?:minute|hour|day|week|month|year)s? ago\b/,
  /\b(?:the )?day (?:after tomorrow|before yesterday)\b/,
  // Czech / Slovak determiners in front of a period or a weekday.
  new RegExp(
    `\\b(?:pristi|pristiho|pristim|priste|minuly|minulej|minuleho|tenhle|tento|tuhle|tuto|budouci|buduci|nasledujici)`
    + ` (?:tyden|tydnu|tydne|tyzden|tyzdna|mesic|mesici|mesiac|rok|roce|roku|vikend|${WEEKDAY})\\b`,
  ),
  // "za tejden", "za 3 dny", "za hodinu"
  /\bza (?:\d+|par|nekolik|dva|tri|ctyri|pet|jeden|jednu) (?:minut\w*|hodin\w*|dn\w*|tyd\w*|tyz\w*|mesic\w*|mesiac\w*|rok\w*|let)\b/,
  /\bza (?:hodinu|chvili|chvilku|tyden|tejden|tyzden|mesic|mesiac|rok|moment|momentik)\b/,
  // "před třemi dny"
  /\bpred (?:\d+|par|nekolika|tremi|dvema) (?:minutami|hodinami|dny|dnami|tydny|tyzdnami|mesici|mesiacmi|lety|rokmi)\b/,
];

/**
 * A bare weekday, or a bare "the weekend". Real enough to be a problem —
 * "moved to friday" is meaningless in a month — but common enough inside an
 * already-dated sentence that it only counts when nothing absolute is present.
 */
const WEAK_PHRASES = [new RegExp(`\\b(?:v|ve|on|na|to|for|by|until) (?:${WEEKDAY}|weekend|vikend)\\b`)];

/** 10.9.2026, 2026-09-10, 10 september 2026 — a date that has already been resolved. */
const ABSOLUTE_DATE = [
  /\b\d{1,2} ?[./-] ?\d{1,2} ?[./-] ?\d{2,4}\b/,
  /\b\d{4} ?- ?\d{1,2} ?- ?\d{1,2}\b/,
  /\b\d{1,2} (?:january|february|march|april|may|june|july|august|september|october|november|december|ledna|unora|brezna|dubna|kvetna|cervna|cervence|srpna|zari|rijna|listopadu|prosince) \d{4}\b/,
];

/** Names shorter than this are matched exactly; a typo allowance would swallow real words. */
const MIN_FUZZY_LENGTH = 5;

function tokenIsRelative(token: string): boolean {
  if (token.length < 3) return false;
  if (RELATIVE_STEMS.some((stem) => token.startsWith(stem))) return true;

  for (const word of RELATIVE_WORDS) {
    if (token === word) return true;
    if (word.length < MIN_FUZZY_LENGTH || token.length < MIN_FUZZY_LENGTH) continue;
    // One slip in a short word, two in a long one: "zitraa", "tommorow", "yestrday".
    if (withinDistance(token, word, word.length >= 8 ? 2 : 1)) return true;
  }
  return false;
}

export function hasRelativeDate(text: string): boolean {
  const folded = normalise(text);
  if (!folded) return false;

  if (folded.split(' ').some(tokenIsRelative)) return true;
  if (RELATIVE_PHRASES.some((pattern) => pattern.test(folded))) return true;

  // A sentence that already carries a real date has usually been resolved, and
  // the weekday in it is describing that date rather than floating free.
  const dated = foldKeepingDateMarks(text);
  const hasAbsolute = ABSOLUTE_DATE.some((pattern) => pattern.test(dated));
  return !hasAbsolute && WEAK_PHRASES.some((pattern) => pattern.test(folded));
}
