/** What the model is allowed to say about a person's behaviour. */
export const ASSESSMENTS = ['hostile', 'rude', 'neutral', 'decent', 'good'] as const;
export type Assessment = (typeof ASSESSMENTS)[number];

/**
 * Where each assessment pulls the short-term score towards. The model judges
 * behaviour and the plugin owns the arithmetic — letting the model pick numbers
 * directly made the scale mean whatever it felt like that turn.
 */
const TARGET: Record<Assessment, number> = {
  hostile: 0,
  rude: 2.5,
  neutral: 5,
  decent: 7.5,
  good: 10,
};

export interface ReputationConfig {
  /** How far short term jumps towards the assessment, 0–1. High: a few messages swing it. */
  shortTermRate: number;
  /** How far long term closes on short term each time, 0–1. Low: it takes many messages. */
  longTermRate: number;
  /** Short term below this counts as behaving badly. */
  lowThreshold: number;
  /** How many assessments in a row below the threshold before the drag starts. */
  dragAfter: number;
  /** Extra downward pull on long term per assessment once the drag has started. */
  dragRate: number;
  /** Where somebody unknown starts, on both scores. */
  startingScore: number;
}

export const DEFAULT_CONFIG: ReputationConfig = {
  shortTermRate: 0.5,
  longTermRate: 0.06,
  lowThreshold: 4,
  dragAfter: 3,
  dragRate: 0.2,
  startingScore: 5,
};

export interface ReputationRow {
  userId: string;
  shortTerm: number;
  longTerm: number;
  lowStreak: number;
  judgements: number;
  updatedAt: number;
}

function clamp(value: number): number {
  return Math.round(Math.min(10, Math.max(0, value)) * 10) / 10;
}

export function withDefaults(config: Partial<ReputationConfig>): ReputationConfig {
  const merged = { ...DEFAULT_CONFIG, ...config };
  // A config edited by hand in the admin panel can arrive as a string or as
  // nonsense; a bad rate here would silently freeze every score.
  const number = (value: unknown, fallback: number): number => {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    shortTermRate: Math.min(1, Math.max(0, number(merged.shortTermRate, DEFAULT_CONFIG.shortTermRate))),
    longTermRate: Math.min(1, Math.max(0, number(merged.longTermRate, DEFAULT_CONFIG.longTermRate))),
    lowThreshold: clamp(number(merged.lowThreshold, DEFAULT_CONFIG.lowThreshold)),
    dragAfter: Math.max(1, Math.round(number(merged.dragAfter, DEFAULT_CONFIG.dragAfter))),
    dragRate: Math.max(0, number(merged.dragRate, DEFAULT_CONFIG.dragRate)),
    startingScore: clamp(number(merged.startingScore, DEFAULT_CONFIG.startingScore)),
  };
}

/**
 * Short term snaps towards the assessment; long term chases wherever short term
 * has landed, far more slowly. The drag is the part that makes a bad stretch
 * cost something: while short term stays under the threshold and the person
 * keeps talking, long term is pulled down harder the longer it goes on, so a
 * couple of polite messages afterwards cannot wipe out a fortnight of abuse.
 */
export function applyAssessment(
  row: ReputationRow,
  assessment: Assessment,
  config: ReputationConfig,
): ReputationRow {
  const target = TARGET[assessment];
  const shortTerm = clamp(row.shortTerm + (target - row.shortTerm) * config.shortTermRate);

  let longTerm = row.longTerm + (shortTerm - row.longTerm) * config.longTermRate;

  const lowStreak = shortTerm < config.lowThreshold ? row.lowStreak + 1 : 0;
  if (lowStreak >= config.dragAfter) {
    longTerm -= config.dragRate * (lowStreak - config.dragAfter + 1);
  }

  return {
    userId: row.userId,
    shortTerm,
    longTerm: clamp(longTerm),
    lowStreak,
    judgements: row.judgements + 1,
    updatedAt: Date.now(),
  };
}
