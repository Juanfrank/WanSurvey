import type { AnswerValue, SpecialKind } from '@wansurvey/schema';
import type { Bubble, LaidQuestion } from './layout.js';

/** Fill at or above which a bubble is marked; between the two, it is doubtful. */
export const MARKED = 0.45;
export const FAINT = 0.18;

/** Why a question goes to the second round. */
export type IssueKind =
  | 'manual' // written by hand
  | 'blank' // nothing marked
  | 'multiple' // more than one mark where one is allowed
  | 'doubtful' // a faint or partial mark
  | 'invalid' // the marks break a rule of the questionnaire (out of range, too many…)
  | 'missing_page' // its page was not in the scans
  | 'off_path'; // marked, but the questionnaire's flow skips it

export interface Reading {
  value?: AnswerValue;
  issue?: { kind: IssueKind; detail?: string };
}

const special = (k: SpecialKind) => ({ $special: k }) as AnswerValue;

type Read = { b: Bubble; f: number };

const pick = (reads: Read[]) => {
  const marked = reads.filter((r) => r.f >= MARKED);
  const faint = reads.filter((r) => r.f >= FAINT && r.f < MARKED);
  return { marked, faint };
};

/** One answer from the marks of a list of bubbles (single choice, scale, a grid row). */
function one(reads: Read[]): { value?: string | number | AnswerValue; issue?: IssueKind } {
  const { marked, faint } = pick(reads);
  if (marked.length > 1) return { issue: 'multiple' };
  if (marked.length === 1) {
    if (faint.length) return { issue: 'doubtful' };
    const b = marked[0]!.b;
    return { value: b.special ? special(b.special) : (b.code as string | number) };
  }
  return faint.length ? { issue: 'doubtful' } : { issue: 'blank' };
}

/**
 * What the marks of a question say. Nothing questionable is guessed: two marks in a single
 * choice, a faint mark or a mark next to "don't know" leave the answer empty with the reason.
 */
export function interpret(q: LaidQuestion, fills: Map<Bubble, number>): Reading {
  const reads = q.bubbles.map((b) => ({ b, f: fills.get(b) ?? 0 }));
  const specials = reads.filter((r) => r.b.special);
  if (q.reading === 'manual') {
    // Written by hand; only a marked "don't know" or "refused" can be read.
    const s = one(specials);
    if (s.value !== undefined) return { value: s.value as AnswerValue };
    return { issue: { kind: s.issue === 'blank' || !specials.length ? 'manual' : s.issue! } };
  }
  if (q.type === 'grid') {
    const rows = new Map<string, Read[]>();
    for (const r of reads) {
      const key = String(r.b.row);
      rows.set(key, [...(rows.get(key) ?? []), r]);
    }
    const value: Record<string, AnswerValue> = {};
    const problems: string[] = [];
    let worst: IssueKind | null = null;
    for (const [row, rr] of rows) {
      const o = one(rr);
      if (o.value !== undefined) value[row] = o.value as AnswerValue;
      else if (o.issue && o.issue !== 'blank') {
        problems.push(`${row}: ${o.issue}`);
        worst = worst === 'multiple' ? worst : o.issue;
      }
    }
    if (worst) return { issue: { kind: worst, detail: problems.join('; ') } };
    if (!Object.keys(value).length) return { issue: { kind: 'blank' } };
    return { value: value as AnswerValue };
  }
  if (q.type === 'multi') {
    const options = reads.filter((r) => !r.b.special);
    const { marked, faint } = pick(options);
    const s = pick(specials);
    if (faint.length || s.faint.length) return { issue: { kind: 'doubtful' } };
    if (s.marked.length && (marked.length || s.marked.length > 1))
      return { issue: { kind: 'multiple' } };
    if (s.marked.length) return { value: special(s.marked[0]!.b.special!) };
    if (!marked.length) return { issue: { kind: 'blank' } };
    return { value: marked.map((r) => r.b.code!) as AnswerValue };
  }
  const o = one(reads);
  if (o.value !== undefined) return { value: o.value as AnswerValue };
  return { issue: { kind: o.issue ?? 'blank' } };
}
