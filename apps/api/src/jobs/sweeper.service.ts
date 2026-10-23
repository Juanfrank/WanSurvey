import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { Database } from '../db/database.js';
import { exports, papiScanBatches } from '../db/schema.js';
import { claimable, MAX_JOB_ATTEMPTS, STUCK_AFTER_MS } from './claims.js';
import { JobsService } from './jobs.service.js';

/** Queued work not taken in this long is offered again (its job was never queued, or lost). */
const WAITING_TOO_LONG_MS = 5 * 60_000;

/**
 * Background work that outlives a lost job (M1): every few minutes, exports and scanned batches
 * still queued well after they were asked for, or running far longer than they take, are
 * queued again; after their last try they are marked failed, so nothing waits for ever.
 */
@Injectable()
export class SweeperService implements OnModuleInit {
  private readonly logger = new Logger('Sweeper');

  constructor(
    private readonly database: Database,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register('jobs.sweep', () => this.sweep());
    this.jobs.schedule('jobs.sweep', { cron: '*/5 * * * *' });
  }

  async sweep(now = new Date()): Promise<{ requeued: number; failed: number }> {
    let requeued = 0;
    let failed = 0;
    const waited = sql`${new Date(now.getTime() - WAITING_TOO_LONG_MS).toISOString()}::timestamptz`;
    const stuck = sql`${new Date(now.getTime() - STUCK_AFTER_MS).toISOString()}::timestamptz`;
    for (const tenantId of await this.database.allTenantIds()) {
      try {
        const found = await this.database.withTenant(tenantId, async (tx) => {
          const work = [
            { table: exports, job: 'exports.build', key: 'exportId' },
            { table: papiScanBatches, job: 'papi.scan', key: 'batchId' },
          ] as const;
          const offers: { job: string; data: Record<string, unknown>; id: string }[] = [];
          for (const w of work) {
            const t = w.table;
            // Left behind: queued and not taken for a while, or abandoned while running.
            const due = await tx
              .select({ id: t.id, attempts: t.attempts })
              .from(t)
              .where(
                and(
                  claimable(t, now),
                  or(and(eq(t.status, 'queued'), lt(t.createdAt, waited)), eq(t.status, 'running')),
                ),
              );
            for (const r of due)
              offers.push({
                job: w.job,
                data: { tenantId, [w.key]: r.id },
                id: `${r.id}.sweep${r.attempts}`,
              });
            // Out of tries: failed, with the reason.
            const gaveUp = await tx
              .update(t)
              .set({
                status: 'failed',
                error: `Stopped after ${MAX_JOB_ATTEMPTS} attempts`,
                finishedAt: now,
              })
              .where(
                and(
                  gte(t.attempts, MAX_JOB_ATTEMPTS),
                  inArray(t.status, ['queued', 'running']),
                  or(eq(t.status, 'queued'), lt(t.startedAt, stuck)),
                ),
              )
              .returning({ id: t.id });
            failed += gaveUp.length;
          }
          return offers;
        });
        for (const o of found)
          if (await this.jobs.offer(o.job, o.data, { jobId: o.id })) requeued++;
      } catch (e) {
        this.logger.error(`Sweep failed for ${tenantId}: ${(e as Error).message}`);
      }
    }
    if (requeued || failed) this.logger.log(`Requeued ${requeued}, gave up on ${failed}`);
    return { requeued, failed };
  }
}
