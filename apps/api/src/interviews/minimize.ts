import type { CaseFieldsUsed } from '@wansurvey/logic';

/** What an interviewer's screen and device get of a case: only what the work needs. */
export interface MinimalCase {
  /** The sample: every field that is not personal, and the personal ones the work needs. */
  case: Record<string, unknown>;
  /**
   * Personal fields kept because the questionnaire shows them (`{{case.first_name}}`, a prefill,
   * a script): for the engine to pipe, never listed on their own on the screen.
   */
  personal: string[];
  /** Personal fields kept to reach the household (face to face only): listed on the screen. */
  fieldwork: string[];
}

/**
 * Data minimisation for interviews (CATI, CAPI, PAPI): personal sample fields reach the
 * interviewer only where the questionnaire uses them, or, face to face, when the project marks
 * them as needed to find the household. Others are left out (not masked: absent).
 */
export function minimizeCase(
  sample: Record<string, unknown>,
  opts: {
    /** The project's personal sample fields. */
    pii: ReadonlySet<string>;
    /** What the questionnaire version reads of the case. */
    used: CaseFieldsUsed | null;
    /** Fields needed in the field (already empty outside face-to-face interviews). */
    fieldwork: readonly string[];
  },
): MinimalCase {
  const used = new Set(opts.used?.fields ?? []);
  const all = !!opts.used?.all;
  const out: Record<string, unknown> = {};
  const personal: string[] = [];
  const fieldwork: string[] = [];
  for (const [k, v] of Object.entries(sample)) {
    if (!opts.pii.has(k)) {
      out[k] = v;
      continue;
    }
    const inField = opts.fieldwork.includes(k);
    if (!all && !used.has(k) && !inField) continue;
    out[k] = v;
    if (inField) fieldwork.push(k);
    else personal.push(k);
  }
  return { case: out, personal, fieldwork };
}
