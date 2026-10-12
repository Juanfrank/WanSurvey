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
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

/** Settings with defaults filled in, from whatever is stored. */
export function projectSettings(stored: unknown): ProjectSettings {
  const parsed = ProjectSettings.safeParse(stored ?? {});
  return parsed.success ? parsed.data : ProjectSettings.parse({});
}
