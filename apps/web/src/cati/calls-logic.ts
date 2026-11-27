import type { CallOutcome } from '@wansurvey/schema';

/**
 * The call outcomes in four groups, so the main path (answered) stands out and the ones that
 * close the case are set apart. Keys stay those of the outcome list (1–9, then 0), so callers keep
 * their habits; in this order they read 1–4, 5–7 and 0, then 8–9.
 */
export const OUTCOME_GROUPS = [
  { id: 'reached', outcomes: ['answered'] },
  { id: 'notReached', outcomes: ['no_answer', 'busy', 'voicemail'] },
  { id: 'final', outcomes: ['wrong_number', 'disconnected', 'refusal', 'do_not_contact'] },
  { id: 'reschedule', outcomes: ['callback', 'appointment'] },
] as const satisfies readonly { id: string; outcomes: readonly CallOutcome[] }[];

export type OutcomeGroup = (typeof OUTCOME_GROUPS)[number]['id'];

/** The groups with only the outcomes offered now, in their order. */
export function groupOutcomes(choices: readonly CallOutcome[]) {
  return OUTCOME_GROUPS.map((g) => ({
    id: g.id as OutcomeGroup,
    outcomes: (g.outcomes as readonly CallOutcome[]).filter((o) => choices.includes(o)),
  })).filter((g) => g.outcomes.length);
}

/** The key of the n-th outcome (0-based): 1–9, then 0 for the tenth. */
export const outcomeKey = (i: number) => (i < 9 ? String(i + 1) : i === 9 ? '0' : null);

/** The outcome index a key chooses (1–9, 0 for the tenth), or -1. */
export const keyIndex = (key: string) =>
  /^[1-9]$/.test(key) ? Number(key) - 1 : key === '0' ? 9 : -1;

/** Calling hours with the same start and end mean no restriction (the queue's rule). */
export const allDay = (h: { from: string; to: string }) => h.from === h.to;

/** Common phone labels from a sample's column header, to show translated. */
const PHONE_KINDS: [RegExp, string][] = [
  [/^(mobile|cell|cellphone|movil|móvil|celular)$/, 'mobile'],
  [/^(landline|home|fijo|casa)$/, 'landline'],
  [/^(work|office|trabajo|oficina)$/, 'work'],
  [/^(phone|tel|telephone|telefono|teléfono|phone_?number)$/, 'phone'],
];

export function phoneKind(label: string | null): string | null {
  const l = (label ?? '').trim().toLowerCase();
  return PHONE_KINDS.find(([re]) => re.test(l))?.[1] ?? null;
}

/**
 * A booked time said in full, so a date picker in the browser's format cannot mislead:
 * "jueves, 26 de noviembre, 20:24", in the respondent's zone.
 */
export function longWhen(at: Date, tz: string, language: string) {
  return at.toLocaleString(language, {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** "in 1 hour", "tomorrow" — how far off a time is, in the interface language. */
export function fromNow(at: Date, now: number, language: string) {
  const min = Math.round((at.getTime() - now) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (Math.abs(min) < 60) return rtf.format(min, 'minute');
  const h = Math.round(min / 60);
  if (Math.abs(h) < 48) return rtf.format(h, 'hour');
  return rtf.format(Math.round(h / 24), 'day');
}

/** The start of the caller's day, for their shift summary. */
export function startOfDay(now: number) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}
