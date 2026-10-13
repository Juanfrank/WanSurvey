import { z } from 'zod';
import { CatiSettings } from './cati.js';

/** How cases reach interviewers: handed out by a supervisor or rules, or claimed from a pool. */
export const ASSIGNMENT_MODES = ['assigned', 'pool'] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];

export const CapiSettings = z.object({
  /** Record the device's location at the start and end of each interview. */
  gps: z.enum(['off', 'start_end']).default('off'),
  /** Shown to interviewers before the location is recorded. */
  gpsNotice: z.string().max(1000).default(''),
});
export type CapiSettings = z.infer<typeof CapiSettings>;

/** Legal grounds for e-mailing a sample (W4); nothing is sent until one is declared. */
export const LAWFUL_BASES = ['consent', 'legitimate_interest', 'contract', 'public_task'] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

export const CawiSettings = z.object({
  lawfulBasis: z.enum(LAWFUL_BASES).nullable().default(null),
  /** Shown as the sender of invitations ("Encuesta de hogares <…>"). */
  senderName: z.string().max(100).default(''),
  /** Shown when a respondent finishes; a default message when empty. */
  completionMessage: z.string().max(2000).default(''),
  /** Where respondents go after finishing (optional). */
  redirectUrl: z.union([z.literal(''), z.url()]).default(''),
});
export type CawiSettings = z.infer<typeof CawiSettings>;

export const PapiSettings = z.object({
  /** Every paper form is keyed twice, by different clerks, and differences are resolved (P3). */
  doubleEntry: z.boolean().default(false),
});
export type PapiSettings = z.infer<typeof PapiSettings>;

export const ReviewSettings = z.object({
  /** Share of each interviewer's completes picked at random for review (R2). */
  samplePercent: z.number().int().min(0).max(100).default(10),
  /** Faster than this per answered question is flagged as speeding. */
  speedingMsPerQuestion: z.number().int().min(0).max(600_000).default(1500),
  /** The same answer on at least this many grid rows (or consecutive items) is straight-lining. */
  straightlineMinItems: z.number().int().min(2).max(100).default(5),
  /** A rejected interview sends its case back to be interviewed again. */
  rejectReopensCase: z.boolean().default(true),
});
export type ReviewSettings = z.infer<typeof ReviewSettings>;

export const FieldworkSettings = z.object({
  /** Completed interviews the project aims for; the dashboard shows progress against it. */
  targetCompletes: z.number().int().min(0).max(10_000_000).nullable().default(null),
});
export type FieldworkSettings = z.infer<typeof FieldworkSettings>;

export const RetentionSettings = z.object({
  /**
   * Days after a case is finished (or withdrawn) when its personal data is removed: personal
   * sample fields, contacts, personal answers, notes and e-mail addresses. Null keeps it.
   */
  anonymiseAfterDays: z.number().int().min(1).max(3650).nullable().default(null),
});
export type RetentionSettings = z.infer<typeof RetentionSettings>;

export const FUNCTION_KEYS = ['F1', 'F2', 'F3', 'F4', 'F6', 'F7', 'F8', 'F9', 'F10'] as const;
/** Ctrl+N, Ctrl+T and Ctrl+W belong to the browser: a page cannot take them over. */
export const RESERVED_LETTERS = ['n', 't', 'w'] as const;
const Letter = z
  .string()
  .regex(/^[a-z]$/)
  .refine((l) => !(RESERVED_LETTERS as readonly string[]).includes(l), {
    message: 'The browser keeps this key',
  });

/**
 * Interviewer keyboard shortcuts (A11): the keys for don't know and refused, and the letters
 * used with Ctrl (⌘ on Mac) for a note, the section navigator and pause.
 */
export const ShortcutSettings = z
  .object({
    dontKnow: z.enum(FUNCTION_KEYS).default('F7'),
    refused: z.enum(FUNCTION_KEYS).default('F8'),
    note: Letter.default('m'),
    navigator: Letter.default('g'),
    pause: Letter.default('p'),
  })
  .refine((s) => s.dontKnow !== s.refused, { message: 'Use different keys', path: ['refused'] })
  .refine((s) => new Set([s.note, s.navigator, s.pause]).size === 3, {
    message: 'Use different letters',
    path: ['pause'],
  });
export type ShortcutSettings = z.infer<typeof ShortcutSettings>;
export const DEFAULT_SHORTCUTS: ShortcutSettings = ShortcutSettings.parse({});

/** Per-project settings, stored as jsonb on `projects.settings`. Missing keys take defaults. */
export const ProjectSettings = z.object({
  /**
   * Interviewers with `pii.view` see the personal data of their own cases without asking;
   * the first view of each case is recorded in the audit log.
   */
  revealToInterviewers: z.boolean().default(true),
  /** `pool`: unassigned cases are open to every interviewer, and the first to claim one holds it. */
  assignmentMode: z.enum(ASSIGNMENT_MODES).default('assigned'),
  /** Telephone interviewing: calling hours, attempts and retry delays. */
  cati: CatiSettings.default(CatiSettings.parse({})),
  /** Face-to-face interviewing on devices. */
  capi: CapiSettings.default(CapiSettings.parse({})),
  /** Web surveys by e-mail. */
  cawi: CawiSettings.default(CawiSettings.parse({})),
  /** Paper forms keyed by data-entry clerks. */
  papi: PapiSettings.default(PapiSettings.parse({})),
  /** Answer review (slice 11). */
  review: ReviewSettings.default(ReviewSettings.parse({})),
  /** Targets for the dashboard (slice 12). */
  fieldwork: FieldworkSettings.default(FieldworkSettings.parse({})),
  /** Personal data retention (slice 13). */
  retention: RetentionSettings.default(RetentionSettings.parse({})),
  /** Interviewer keyboard shortcuts (slice 13). */
  shortcuts: ShortcutSettings.default(DEFAULT_SHORTCUTS),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

/** Settings with defaults filled in, from whatever is stored. */
export function projectSettings(stored: unknown): ProjectSettings {
  const parsed = ProjectSettings.safeParse(stored ?? {});
  return parsed.success ? parsed.data : ProjectSettings.parse({});
}
