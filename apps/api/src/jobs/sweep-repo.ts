import { Injectable } from '@nestjs/common';
import { sql as ksql } from 'kysely';
import { Engine } from '../db/engine.js';
import { instant } from '../db/mssql/instant.js';
import { MAX_JOB_ATTEMPTS, STUCK_AFTER_MS } from './claims.js';

/** Queued work not taken in this long is offered again (its job was never queued, or lost). */
const WAITING_TOO_LONG_MS = 5 * 60_000;

export interface SweepOffer {
  job: string;
  data: Record<string, unknown>;
  id: string;
}

/**
 * The database side of the sweeper, whichever engine runs: in one organisation, the jobs left
 * behind (to offer again) and the ones out of tries (marked failed).
 */
export interface SweepRepo {
  sweepTenant(tenantId: string, now: Date): Promise<{ offers: SweepOffer[]; failed: number }>;
}

const WORK = [
  { table: 'exports', job: 'exports.build', key: 'exportId' },
  { table: 'papi_scan_batches', job: 'papi.scan', key: 'batchId' },
] as const;

@Injectable()
export class MssqlSweepRepo implements SweepRepo {
  constructor(private readonly engine: Engine) {}

  sweepTenant(tenantId: string, now: Date) {
    const waited = instant(new Date(now.getTime() - WAITING_TOO_LONG_MS));
    const stuck = instant(new Date(now.getTime() - STUCK_AFTER_MS));
    return this.engine.sql.withTenant(tenantId, async (tx) => {
      const offers: SweepOffer[] = [];
      let failed = 0;
      for (const w of WORK) {
        const table = ksql.raw(`dbo.${w.table}`);
        const due = await ksql<{ id: string; attempts: number }>`
          SELECT id, attempts FROM ${table}
          WHERE attempts < ${MAX_JOB_ATTEMPTS}
            AND ((status = 'queued' AND created_at < ${waited})
              OR (status = 'running' AND started_at < ${stuck}))`.execute(tx);
        for (const r of due.rows) {
          const id = r.id.toLowerCase();
          offers.push({
            job: w.job,
            data: { tenantId, [w.key]: id },
            id: `${id}.sweep${r.attempts}`,
          });
        }
        const gaveUp = await ksql<{ id: string }>`
          UPDATE ${table}
          SET status = 'failed', error = ${`Stopped after ${MAX_JOB_ATTEMPTS} attempts`},
            finished_at = ${instant(now)}
          OUTPUT inserted.id
          WHERE attempts >= ${MAX_JOB_ATTEMPTS} AND status IN ('queued', 'running')
            AND (status = 'queued' OR started_at < ${stuck})`.execute(tx);
        failed += gaveUp.rows.length;
      }
      return { offers, failed };
    });
  }
}

export const SWEEP_REPO = Symbol('SWEEP_REPO');
