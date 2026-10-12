import { z } from 'zod';
import { DISPOSITIONS, type Disposition } from './disposition.js';

/** What can happen on a call (spec §6.2). */
export const CALL_OUTCOMES = [
  'answered',
  'no_answer',
  'busy',
  'voicemail',
  'wrong_number',
  'disconnected',
  'refusal',
  'callback',
  'appointment',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** Disposition each outcome gives the case (K4). Answered: the interview decides. */
export const OUTCOME_DISPOSITION: Record<CallOutcome, Disposition | null> = {
  answered: null,
  no_answer: 'NO_ANSWER',
  busy: 'BUSY',
  voicemail: 'ANSWERING_MACHINE',
  wrong_number: 'WRONG_NUMBER',
  disconnected: 'DISCONNECTED',
  refusal: 'REFUSAL',
  callback: 'CALLBACK',
  appointment: 'CALLBACK',
};

/** Outcomes that finish the case. */
export const isFinalOutcome = (o: CallOutcome) => {
  const d = OUTCOME_DISPOSITION[o];
  return !!d && DISPOSITIONS[d].final;
};

/** Outcomes that need a time to call again. */
export const needsCallbackTime = (o: CallOutcome) => o === 'callback' || o === 'appointment';

/** The script anchor shown after an outcome (`callOutcome` scripts). */
export const OUTCOME_SCRIPT: Partial<Record<CallOutcome, string>> = {
  answered: 'answered',
  no_answer: 'no_answer',
  busy: 'busy',
  voicemail: 'voicemail',
  wrong_number: 'wrong_number',
  refusal: 'refusal',
  callback: 'callback',
  appointment: 'callback',
};

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const CatiSettings = z.object({
  /** Calling hours in the respondent's time zone. */
  callingHours: z.object({ from: HHMM, to: HHMM }).default({ from: '09:00', to: '21:00' }),
  maxAttempts: z.number().int().min(1).max(50).default(8),
  /** Minutes before trying again after each temporary outcome. */
  retryMinutes: z
    .object({
      no_answer: z.number().int().min(1).max(10_080),
      busy: z.number().int().min(1).max(10_080),
      voicemail: z.number().int().min(1).max(10_080),
    })
    .default({ no_answer: 120, busy: 15, voicemail: 240 }),
});
export type CatiSettings = z.infer<typeof CatiSettings>;
