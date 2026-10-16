import { z } from 'zod';
import { LocalizedText } from './common.js';

/** Follow-up questions a Likert point may have after its mandatory Likert (F2). */
export const MAX_FEEDBACK_ITEMS = 5;

export const FEEDBACK_ITEM_TYPES = ['text', 'single', 'multi', 'yesno', 'number'] as const;

/**
 * A follow-up question of a Likert point. `id` is its variable name in the results; `param`
 * lets a link answer it beforehand (`?sede=2`): it is then recorded and never shown.
 */
export const FeedbackItem = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/),
  type: z.enum(FEEDBACK_ITEM_TYPES),
  text: LocalizedText,
  /** A text box of several lines. */
  long: z.boolean().optional(),
  options: z
    .array(z.object({ code: z.number().int().min(-99).max(999), label: LocalizedText }))
    .max(30)
    .optional(),
  required: z.boolean().default(false),
  /** Shown only when the face given is within this range (e.g. only to the unhappy). */
  showIf: z
    .object({ min: z.number().int().min(1).max(5), max: z.number().int().min(1).max(5) })
    .optional(),
  param: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,31}$/)
    .optional(),
});
export type FeedbackItem = z.infer<typeof FeedbackItem>;

export const FeedbackItems = z
  .array(FeedbackItem)
  .max(MAX_FEEDBACK_ITEMS)
  .superRefine((items, ctx) => {
    const ids = new Set<string>();
    const params = new Set<string>(['r', 'ref', 'embed']);
    items.forEach((it, i) => {
      if (ids.has(it.id.toUpperCase()) || it.id.toUpperCase() === 'LIKERT')
        ctx.addIssue({ code: 'custom', message: `Repeated id ${it.id}`, path: [i, 'id'] });
      ids.add(it.id.toUpperCase());
      if (it.param) {
        if (params.has(it.param))
          ctx.addIssue({
            code: 'custom',
            message: `Repeated parameter ${it.param}`,
            path: [i, 'param'],
          });
        params.add(it.param);
      }
      if ((it.type === 'single' || it.type === 'multi') && !it.options?.length)
        ctx.addIssue({ code: 'custom', message: `${it.id} needs options`, path: [i, 'options'] });
    });
  });

/** Checks one answer against its question; null when it is fine. */
export function feedbackAnswerError(item: FeedbackItem, v: unknown): string | null {
  if (v === null || v === undefined || v === '') return item.required ? 'required' : null;
  switch (item.type) {
    case 'text':
      return typeof v === 'string' && v.length <= 2000 ? null : 'invalid';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : 'invalid';
    case 'yesno':
      return v === 1 || v === 2 ? null : 'invalid';
    case 'single':
      return item.options?.some((o) => o.code === v) ? null : 'invalid';
    case 'multi':
      return Array.isArray(v) &&
        v.length > 0 &&
        v.every((c) => item.options?.some((o) => o.code === c))
        ? null
        : 'invalid';
  }
}

/** True when the item applies to the face given (its showIf range). */
export const feedbackItemShown = (item: FeedbackItem, score: number) =>
  !item.showIf || (score >= item.showIf.min && score <= item.showIf.max);
