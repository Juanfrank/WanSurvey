import { z } from 'zod';

/**
 * Final and temporary outcome codes, grouped after the AAPOR Standard Definitions
 * (1.x interview, 2.x eligible non-interview, 3.x unknown eligibility, 4.x not eligible).
 */
export const DISPOSITIONS = {
  COMPLETE: { aapor: '1.1', group: 'interview', final: true },
  PARTIAL: { aapor: '1.2', group: 'interview', final: true },
  REFUSAL: { aapor: '2.11', group: 'eligible_non_interview', final: true },
  BREAK_OFF: { aapor: '2.12', group: 'eligible_non_interview', final: true },
  NON_CONTACT: { aapor: '2.20', group: 'eligible_non_interview', final: true },
  RESPONDENT_UNAVAILABLE: { aapor: '2.21', group: 'eligible_non_interview', final: false },
  LANGUAGE_BARRIER: { aapor: '2.33', group: 'eligible_non_interview', final: true },
  NO_ANSWER: { aapor: '3.13', group: 'unknown_eligibility', final: false },
  BUSY: { aapor: '3.12', group: 'unknown_eligibility', final: false },
  ANSWERING_MACHINE: { aapor: '3.14', group: 'unknown_eligibility', final: false },
  CALLBACK: { aapor: '2.21', group: 'eligible_non_interview', final: false },
  NOT_STARTED: { aapor: '3.10', group: 'unknown_eligibility', final: false },
  EMAIL_BOUNCED: { aapor: '3.21', group: 'unknown_eligibility', final: false },
  WRONG_NUMBER: { aapor: '4.41', group: 'not_eligible', final: true },
  DISCONNECTED: { aapor: '4.31', group: 'not_eligible', final: true },
  SCREENED_OUT: { aapor: '4.70', group: 'not_eligible', final: true },
  QUOTA_FULL: { aapor: '4.80', group: 'not_eligible', final: true },
} as const;

export type Disposition = keyof typeof DISPOSITIONS;
export const Disposition = z.enum(Object.keys(DISPOSITIONS) as [Disposition, ...Disposition[]]);
