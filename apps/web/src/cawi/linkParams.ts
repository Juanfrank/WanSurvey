import { YES_NO_OPTIONS } from '@wansurvey/logic';
import { pick } from '@wansurvey/renderer';
import type { Question } from '@wansurvey/schema';

/** A question a link can answer beforehand (`urlParam`), as the link builder offers it. */
export interface ParamQuestion {
  /** The name in the address (`?sede=2`). */
  param: string;
  name: string;
  text: string;
  type: Question['type'];
  /** The codes a choice question takes, with their labels. */
  options: { code: string; label: string }[];
  scale?: { min: number; max: number };
  maxLength?: number;
}

type Item = { kind?: string; items?: Item[] } & Record<string, unknown>;

/**
 * The questions of a questionnaire that a link can answer: those with a link parameter, outside
 * rosters (the engine takes a parameter only for those), in questionnaire order.
 */
export function paramQuestions(
  def: { sections?: { items?: unknown[] }[]; answerSets?: Record<string, unknown[]> },
  lang: string,
): ParamQuestion[] {
  const out: ParamQuestion[] = [];
  const visit = (items: unknown[] | undefined) => {
    for (const raw of items ?? []) {
      const it = raw as Item;
      if (it.kind === 'block') visit(it.items);
      else if (it.kind === 'question' && typeof it.urlParam === 'string') {
        const q = it as unknown as Question;
        const opts =
          q.options && q.options.length
            ? q.options
            : q.answerSetId
              ? ((def.answerSets?.[q.answerSetId] ?? []) as NonNullable<Question['options']>)
              : q.type === 'yesno'
                ? YES_NO_OPTIONS
                : [];
        out.push({
          param: q.urlParam!,
          name: q.name,
          text: pick(q.text, lang) ?? q.name,
          type: q.type,
          options: opts.map((o) => ({ code: String(o.code), label: pick(o.label, lang) ?? '' })),
          ...(q.scale ? { scale: { min: q.scale.min, max: q.scale.max } } : {}),
          ...(q.maxLength ? { maxLength: q.maxLength } : {}),
        });
      }
    }
  };
  for (const s of def.sections ?? []) visit(s.items);
  return out;
}

/**
 * Why a value would not be taken as the answer (the engine drops it and asks the question), as
 * a key of `cawi.builder.problems`, or null when it fits.
 */
export function valueProblem(q: ParamQuestion, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const n = Number(v);
  switch (q.type) {
    case 'single':
      return q.options.some((o) => o.code === v) ? null : 'notAnOption';
    case 'multi':
      return v
        .split(/[,;]/)
        .map((x) => x.trim())
        .every((x) => q.options.some((o) => o.code === x))
        ? null
        : 'notAnOption';
    case 'yesno':
      return v === '1' || v === '2' ? null : 'notAnOption';
    case 'scale':
      return Number.isFinite(n) && (!q.scale || (n >= q.scale.min && n <= q.scale.max))
        ? null
        : 'outOfRange';
    case 'numeric':
      return Number.isFinite(n) ? null : 'notANumber';
    case 'text':
      return q.maxLength && v.length > q.maxLength ? 'tooLong' : null;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : 'notADate';
    default:
      return null;
  }
}

/** `param=value` pairs as a query string, each part encoded; pairs without a value are left out. */
export function buildQuery(entries: { param: string; value: string }[]): string {
  return entries
    .filter((e) => e.param && e.value.trim() !== '')
    .map((e) => `${encodeURIComponent(e.param)}=${encodeURIComponent(e.value.trim())}`)
    .join('&');
}

/** An address with the parameters added (after any it already has). */
export function withQuery(url: string, query: string): string {
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/**
 * One address per value of a segmenting parameter, each with the fixed parameters too: for
 * handing out a link per branch, group or panel.
 */
export function segmentLinks(
  base: string,
  fixed: { param: string; value: string }[],
  segment: ParamQuestion,
  values: string[],
): { value: string; label: string; url: string }[] {
  return values.map((value) => ({
    value,
    label: segment.options.find((o) => o.code === value)?.label ?? value,
    url: withQuery(base, buildQuery([...fixed, { param: segment.param, value }])),
  }));
}
