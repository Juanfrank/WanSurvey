import {
  createInterview,
  parseKey,
  seededRandom,
  type CompiledQuestionnaire,
  type InterviewSession,
} from '@wansurvey/logic';
import type { AnswerValue, Question } from '@wansurvey/schema';

const FIRST_NAMES = ['Ana', 'Luis', 'María', 'José', 'Rosa', 'Carlos', 'Lucía', 'Jorge', 'Elena'];

/**
 * Answers a questionnaire the way a plausible respondent might, for demo data and load tests:
 * every question on the path gets a valid random answer (consent always yes, adults only),
 * warnings are confirmed, and the walk stops at the end or at an early ending.
 */
export function simulateInterview(
  compiled: CompiledQuestionnaire,
  opts: { mode: string; seed: string; caseData?: Record<string, unknown>; now?: Date },
): InterviewSession {
  const rnd = seededRandom(opts.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const now = opts.now ?? new Date();
  const s = createInterview(compiled, {
    mode: opts.mode as never,
    language: compiled.questionnaire.defaultLanguage,
    seed: opts.seed,
    now: () => now,
    context: { case: opts.caseData ?? {} },
  });
  const defOf = (name: string) =>
    compiled.nodes.find((n) => n.kind === 'question' && (n.def as Question).name === name)?.def as
      Question | undefined;

  const answerFor = (key: string, q: Question, attempt: number): AnswerValue => {
    const codes = s
      .optionsFor(key)
      .options.filter((o) => !o.exclusive)
      .map((o) => o.code);
    const name = q.name.toUpperCase();
    switch (q.type) {
      case 'yesno':
        return /CONSENT|ACEPTA/.test(name) ? 1 : rnd() < 0.7 ? 1 : 2;
      case 'single':
        return pick(codes.length ? codes : [1]);
      case 'multi': {
        const chosen = codes.filter(() => rnd() < 0.4);
        return chosen.length ? chosen : [pick(codes)];
      }
      case 'ranking':
        return [...codes].sort(() => rnd() - 0.5);
      case 'grid': {
        const out: Record<string, AnswerValue> = {};
        for (const r of q.rows ?? []) out[String(r.code)] = pick(codes.length ? codes : [1]);
        return out as unknown as AnswerValue;
      }
      case 'numeric':
      case 'scale': {
        const min = (q as { min?: number }).min ?? 0;
        const max = (q as { max?: number }).max ?? min + 10;
        if (/AGE|EDAD/.test(name)) return int(Math.max(min, 18), Math.min(max, 85));
        if (q.type === 'scale') return int(min, max);
        // Counts (people in the household…) stay small; a refused value is retried lower,
        // down to the minimum, which satisfies checks such as "children < household size".
        const span = Math.max(0, 5 - attempt * 2);
        return int(Math.min(max, min + (attempt ? 0 : 1)), Math.min(max, min + span));
      }
      case 'date':
        return `19${int(50, 99)}-0${int(1, 9)}-1${int(0, 9)}`;
      case 'time':
        return `${String(int(8, 20)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}`;
      default:
        if ((q as { pattern?: string }).pattern?.includes('0-9'))
          return String(int(900_000_000, 999_999_999));
        return /NAME|NOMBRE/.test(name)
          ? pick(FIRST_NAMES)
          : pick(['Bien', 'Regular', 'Sin comentarios']);
    }
  };

  for (let steps = 0, stuck = 0; steps < 2000 && stuck < 8; steps++) {
    const key = s.currentKey();
    if (!key) break;
    const parsed = parseKey(key);
    const q = parsed ? defOf(parsed.name) : undefined;
    if (q && s.getAnswer(key) === null) {
      s.setAnswer(key, answerFor(key, q, stuck));
      if (
        s.getAnswer(`${key}_OTHER`) === null &&
        s.validate(key).errors.some((e) => e.ruleId === 'other_specify')
      )
        s.setAnswer(`${key}_OTHER`, 'Otra');
    }
    for (const w of s.validate(key).warnings) if (!w.confirmed) s.confirmWarning(key, w.ruleId);
    const r = s.next();
    if (r.done || s.endState()) break;
    if (!r.ok) {
      stuck++;
      if (q) s.clearAnswer(key);
    } else stuck = 0;
  }
  return s;
}
