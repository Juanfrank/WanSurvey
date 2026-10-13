import type { CompiledQuestionnaire } from '@wansurvey/logic';
import type { Question, ReviewSettings } from '@wansurvey/schema';
import { createHash } from 'node:crypto';

/** Quality flags on a submitted interview (R3). Absent keys are not flagged. */
export interface Flags {
  /** Average active time per answered question below the threshold (ms per question). */
  speeding?: number;
  /** Variables answered with the same code across too many rows or items in a row. */
  straightlining?: string[];
  /** Soft warnings the interviewer confirmed to go on. */
  warningsOverridden?: number;
  /** "Other, specify" texts given. */
  otherText?: number;
  /** PAPI double-entry differences found. */
  doubleEntry?: number;
}

export const FLAG_KINDS = [
  'speeding',
  'straightlining',
  'warningsOverridden',
  'otherText',
  'doubleEntry',
] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

const isSpecial = (v: unknown) => !!v && typeof v === 'object' && '$special' in (v as object);
const answered = (v: unknown) =>
  v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);

/** Answer keys whose base variable is a question of `type`, in path order. */
function questionVars(compiled: CompiledQuestionnaire) {
  const out = new Map<string, Question>();
  for (const n of compiled.nodes)
    if (n.kind === 'question') out.set((n.def as Question).name, n.def as Question);
  return out;
}

const baseName = (key: string) =>
  key
    .replace(/\[\d+\]/g, '')
    .split('.')
    .pop()!;

export function computeFlags(input: {
  compiled: CompiledQuestionnaire;
  answers: Record<string, unknown>;
  /** Answer keys on the path, in order. */
  path: string[];
  activeMs: number;
  warningsConfirmed: number;
  doubleEntryDifferences?: number;
  settings: ReviewSettings;
}): Flags {
  const { compiled, answers, path, settings } = input;
  const flags: Flags = {};
  const qs = questionVars(compiled);
  const onPath = path.filter((k) => qs.has(baseName(k)) && answered(answers[k]));

  // Speeding: active time spread over answered questions.
  if (onPath.length >= 3 && input.activeMs > 0) {
    const per = Math.round(input.activeMs / onPath.length);
    if (per < settings.speedingMsPerQuestion) flags.speeding = per;
  }

  // Straight-lining: a grid with every row on the same code, or a run of single-choice
  // questions sharing an answer set and the same code.
  const lined: string[] = [];
  for (const k of onPath) {
    const q = qs.get(baseName(k))!;
    const v = answers[k];
    if (q.type === 'grid' && v && typeof v === 'object' && !Array.isArray(v)) {
      const codes = Object.values(v as Record<string, unknown>).filter((x) => !isSpecial(x));
      if (codes.length >= settings.straightlineMinItems && new Set(codes.map(String)).size === 1)
        lined.push(k);
    }
  }
  let run: string[] = [];
  let runSet: string | null = null;
  let runCode: string | null = null;
  const closeRun = () => {
    if (run.length >= settings.straightlineMinItems) lined.push(...run);
    run = [];
    runSet = null;
    runCode = null;
  };
  for (const k of onPath) {
    const q = qs.get(baseName(k))!;
    const set = q.type === 'single' && q.answerSetId ? q.answerSetId : null;
    const v = answers[k];
    const code = set && !isSpecial(v) ? String(v) : null;
    if (set && code !== null && set === runSet && code === runCode) run.push(k);
    else {
      closeRun();
      if (set && code !== null) {
        run = [k];
        runSet = set;
        runCode = code;
      }
    }
  }
  closeRun();
  if (lined.length) flags.straightlining = lined;

  if (input.warningsConfirmed > 0) flags.warningsOverridden = input.warningsConfirmed;
  const others = Object.entries(answers).filter(
    ([k, v]) => /_OTHER$/.test(baseName(k)) && typeof v === 'string' && v.trim(),
  ).length;
  if (others) flags.otherText = others;
  if (input.doubleEntryDifferences) flags.doubleEntry = input.doubleEntryDifferences;
  return flags;
}

/** Picks an interview for the random review sample: stable for the same id (R2). */
export function inSample(interviewId: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const h = createHash('sha256').update(interviewId).digest().readUInt32BE(0);
  return h % 100 < percent;
}
