import { z } from 'zod';

/**
 * Why an interview stopped before its end: a list chosen by each project (the area gives its own
 * list; these generic ones are used meanwhile). Recorded on the interview with an optional note.
 */
export const ExitReason = z.object({
  /** Stable code, kept when the wording changes. */
  code: z.string().regex(/^[a-z0-9_]{1,40}$/),
  /** The wording by language (`es`, `en`…). */
  label: z
    .record(z.string().min(2).max(16), z.string().trim().min(1).max(120))
    .refine((l) => Object.keys(l).length > 0, 'a label in at least one language'),
});
export type ExitReason = z.infer<typeof ExitReason>;

export const GENERIC_EXIT_REASONS: ExitReason[] = [
  {
    code: 'chose_to_stop',
    label: { es: 'La persona decidió terminar', en: 'The person chose to stop' },
  },
  { code: 'no_time', label: { es: 'No tenía tiempo', en: 'No time' } },
  { code: 'call_dropped', label: { es: 'Se cortó la llamada', en: 'The call dropped' } },
  { code: 'technical', label: { es: 'Problema técnico', en: 'Technical problem' } },
  { code: 'sensitive', label: { es: 'Tema que incomoda', en: 'Uncomfortable topic' } },
  { code: 'other', label: { es: 'Otro motivo', en: 'Other reason' } },
];

export const EarlyExitSettings = z.object({
  reasons: z.array(ExitReason).max(30).default(GENERIC_EXIT_REASONS),
  /** A telephone interview cannot be closed as interrupted without one. */
  required: z.boolean().default(false),
});
export type EarlyExitSettings = z.infer<typeof EarlyExitSettings>;

/** The wording of a reason in a language, else Spanish, else the first there is, else the code. */
export const exitReasonLabel = (r: ExitReason, lang: string) =>
  r.label[lang] ?? r.label.es ?? Object.values(r.label)[0] ?? r.code;
