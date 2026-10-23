import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/** Tries of a background job (export, scanned batch) before it is marked failed. */
export const MAX_JOB_ATTEMPTS = 3;
/** A job running longer than this lost its worker (exports and scans take minutes, not this). */
export const STUCK_AFTER_MS = 30 * 60_000;

interface JobRow {
  status: PgColumn;
  startedAt: PgColumn;
  attempts: PgColumn;
}

/** A row a worker may take: queued, or running but abandoned, with tries left. */
export function claimable(t: JobRow, now = new Date()) {
  return and(
    lt(t.attempts, MAX_JOB_ATTEMPTS),
    or(
      eq(t.status, 'queued'),
      and(
        eq(t.status, 'running'),
        lt(
          t.startedAt,
          sql`${new Date(now.getTime() - STUCK_AFTER_MS).toISOString()}::timestamptz`,
        ),
      ),
    ),
  );
}
