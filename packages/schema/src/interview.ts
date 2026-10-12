import { z } from 'zod';
import { Disposition } from './disposition.js';
import { IsoDateTime, Mode, Uuid } from './common.js';
import { SpecialKind } from './questionnaire.js';

/** DK / Refused / Not applicable are stored as tagged values so every question type can hold them. */
export const SpecialValue = z.strictObject({ $special: SpecialKind });
export type SpecialValue = z.infer<typeof SpecialValue>;

export type AnswerValue =
  | null
  | number
  | string
  | boolean
  | SpecialValue
  | Array<number | string>
  | { [row: string]: number | string | SpecialValue }
  | RosterRow[];

export interface RosterRow {
  [variable: string]: AnswerValue;
}

export const AnswerValueSchema: z.ZodType<AnswerValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.number(),
    z.string(),
    z.boolean(),
    SpecialValue,
    z.array(z.union([z.number(), z.string()])),
    z.array(z.record(z.string(), AnswerValueSchema)),
    z.record(z.string(), z.union([z.number(), z.string(), SpecialValue])),
  ]),
);

/** Live answers keyed by variable name. Roster answers are arrays of row objects. */
export const Answers = z.record(z.string(), AnswerValueSchema);
export type Answers = Record<string, AnswerValue>;

export const InterviewStatus = z.enum([
  'in_progress',
  'submitted',
  'in_review',
  'approved',
  'returned',
  'resubmitted',
  'rejected',
]);
export type InterviewStatus = z.infer<typeof InterviewStatus>;

export const Interview = z.object({
  id: Uuid,
  tenantId: Uuid,
  caseId: Uuid.nullable(),
  questionnaireVersionId: Uuid,
  mode: Mode,
  interviewerId: Uuid.nullable(),
  status: InterviewStatus,
  disposition: Disposition.nullable(),
  startedAt: IsoDateTime.nullable(),
  endedAt: IsoDateTime.nullable(),
  /** Key of the item the interview is positioned on, e.g. `HH[2].AGE`. */
  currentPosition: z.string().nullable(),
  answers: Answers,
  language: z.string(),
});
export type Interview = z.infer<typeof Interview>;

export const AnswerSource = z.enum(['interviewer', 'respondent', 'reviewer', 'system']);
export type AnswerSource = z.infer<typeof AnswerSource>;

export const AnswerEvent = z.object({
  interviewId: Uuid,
  /** Answer key, e.g. `Q5` or `HH_MEMBERS[2].AGE`. */
  variable: z.string(),
  oldValue: AnswerValueSchema,
  newValue: AnswerValueSchema,
  at: IsoDateTime,
  by: Uuid.nullable(),
  source: AnswerSource,
  /** Why the system changed it (path change, prefill, computed...). */
  reason: z.string().optional(),
});
export type AnswerEvent = z.infer<typeof AnswerEvent>;

export const PARADATA_TYPES = [
  'enter_question',
  'leave_question',
  'navigate_back',
  'pause',
  'resume',
  'focus_lost',
  'focus_gained',
  'sync',
  'language_switch',
  'warning_confirmed',
  'answers_cleared',
  'note_added',
] as const;
export const ParadataType = z.enum(PARADATA_TYPES);

export const ParadataEvent = z.object({
  interviewId: Uuid,
  type: ParadataType,
  at: IsoDateTime,
  /** Monotonic ms since session start, anchored to the server time offset. */
  monotonicMs: z.number().nonnegative().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type ParadataEvent = z.infer<typeof ParadataEvent>;

export const Case = z.object({
  id: Uuid,
  tenantId: Uuid,
  projectId: Uuid,
  externalId: z.string(),
  sampleData: z.record(z.string(), z.unknown()),
  assignedInterviewerId: Uuid.nullable(),
  status: z.string(),
  priority: z.number().int().default(0),
  modePreference: Mode.nullable(),
});
export type Case = z.infer<typeof Case>;

/** Channel is open-ended from day one so WhatsApp/SMS can be added without a migration. */
export const InvitationChannel = z.enum(['email', 'sms', 'whatsapp']);
export type InvitationChannel = z.infer<typeof InvitationChannel>;
