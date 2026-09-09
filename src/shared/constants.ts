/**
 * Embedding model and dimensionality are baked into the Chroma collection at
 * creation time — changing either requires recreating the collection, so they
 * are constants here rather than admin-editable settings.
 */
export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSIONS = 768;

export const FACTS_COLLECTION = 'facts';

export const DEFAULT_SETTINGS = {
  chatModel: 'gemini-3.1-flash-lite',
  checkIntervalMinutes: 60,
  replyContextMessages: 15,
  factSearchTopK: 8,
  escalationLookbackHours: 24,
  maxEscalationDepth: 1,
  replyLanguage: 'en',
  timezone: 'UTC',
  rateLimitPerHour: 40,
  rateLimitMessage: "You've hit me up a lot this hour — give me a bit and try again.",
  retryAttempts: 2,
  retryDelayMs: 3000,
  duplicateDistance: 25,
  modelFailureThreshold: 3,
  modelRestMinutes: 120,
  visionEnabled: true,
  maxImages: 4,
  crossChannelMessages: 30,
  overloadMessage: "Gemini's getting hammered right now and won't talk to me. Try again in a minute.",
} as const;

/** HTTP statuses from Gemini that mean "try again shortly" rather than "you did something wrong". */
export const RETRYABLE_STATUSES = new Set([429, 500, 503, 504]);

/** Window the per-user reply cap is measured over. */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** The language the bot defaults to, unless whoever tagged it wrote in another one. */
export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'cs', name: 'Czech', native: 'Čeština' },
  { code: 'sk', name: 'Slovak', native: 'Slovenčina' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands' },
  { code: 'pl', name: 'Polish', native: 'Polski' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'ro', name: 'Romanian', native: 'Română' },
  { code: 'hu', name: 'Hungarian', native: 'Magyar' },
  { code: 'bg', name: 'Bulgarian', native: 'Български' },
  { code: 'hr', name: 'Croatian', native: 'Hrvatski' },
  { code: 'sr', name: 'Serbian', native: 'Српски' },
  { code: 'sl', name: 'Slovenian', native: 'Slovenščina' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe' },
  { code: 'sv', name: 'Swedish', native: 'Svenska' },
  { code: 'no', name: 'Norwegian', native: 'Norsk' },
  { code: 'da', name: 'Danish', native: 'Dansk' },
  { code: 'fi', name: 'Finnish', native: 'Suomi' },
  { code: 'et', name: 'Estonian', native: 'Eesti' },
  { code: 'lv', name: 'Latvian', native: 'Latviešu' },
  { code: 'lt', name: 'Lithuanian', native: 'Lietuvių' },
  { code: 'is', name: 'Icelandic', native: 'Íslenska' },
  { code: 'ga', name: 'Irish', native: 'Gaeilge' },
  { code: 'ca', name: 'Catalan', native: 'Català' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'he', name: 'Hebrew', native: 'עברית' },
  { code: 'fa', name: 'Persian', native: 'فارسی' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
  { code: 'ur', name: 'Urdu', native: 'اردو' },
  { code: 'th', name: 'Thai', native: 'ไทย' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'ms', name: 'Malay', native: 'Bahasa Melayu' },
  { code: 'tl', name: 'Filipino', native: 'Filipino' },
  { code: 'zh', name: 'Chinese', native: '中文' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili' },
  { code: 'af', name: 'Afrikaans', native: 'Afrikaans' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

export function languageName(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.name ?? 'English';
}

/** Ceiling applied server-side regardless of what an admin saves, to bound cost and latency. */
export const MAX_ESCALATION_DEPTH_HARD_CAP = 3;

/** duplicateDistance is stored as hundredths so the setting stays an integer. */
export const DUPLICATE_DISTANCE_MAX = 60;

/** Discord caps a single message at 2000 characters. */
export const DISCORD_MESSAGE_LIMIT = 2000;

export const SESSION_COOKIE = 'by_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Formats "Sunday 7 September 2026, 18:42" in the configured zone, for prompts. */
export function formatNow(timezone: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone,
    }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    }).format(at);
  }
}
