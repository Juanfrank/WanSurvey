/** Tries of a background job (export, scanned batch) before it is marked failed. */
export const MAX_JOB_ATTEMPTS = 3;
/** A job running longer than this lost its worker (exports and scans take minutes, not this). */
export const STUCK_AFTER_MS = 30 * 60_000;
