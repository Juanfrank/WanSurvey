import { sql } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';

/** Tables of background jobs that are queued, run, and retried when a worker is lost. */
export type JobTable = 'exports' | 'papi_scan_batches';

/**
 * Takes a job once: a queued one, or one whose worker was lost (running for too long), that still
 * has attempts left. The conditional update is the claim: two workers racing for the same job
 * cannot both get it (the second finds it running). Returns whether this caller got it. The
 */
export async function claimJob(
  tx: MssqlTx,
  table: JobTable,
  id: string,
  opts: { maxAttempts: number; stuckMs: number; now?: Date },
): Promise<boolean> {
  const now = (opts.now ?? new Date()).toISOString();
  const res = await sql<{ id: string }>`
    UPDATE ${sql.raw(`dbo.${table}`)}
    SET status = 'running', started_at = ${now}, attempts = attempts + 1
    OUTPUT inserted.id
    WHERE id = ${id} AND attempts < ${opts.maxAttempts}
      AND (status = 'queued'
        OR (status = 'running' AND started_at < DATEADD(millisecond, ${-opts.stuckMs}, ${now})))`.execute(
    tx,
  );
  return res.rows.length > 0;
}
