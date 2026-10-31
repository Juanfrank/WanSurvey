import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Engine } from '../db/engine.js';
import { JobsService } from './jobs.service.js';
import { SWEEP_REPO, type SweepRepo } from './sweep-repo.js';

/**
 * Background work that outlives a lost job (M1): every few minutes, exports and scanned batches
 * still queued well after they were asked for, or running far longer than they take, are
 * queued again; after their last try they are marked failed, so nothing waits for ever.
 */
@Injectable()
export class SweeperService implements OnModuleInit {
  private readonly logger = new Logger('Sweeper');

  constructor(
    @Inject(SWEEP_REPO) private readonly repo: SweepRepo,
    private readonly engine: Engine,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register('jobs.sweep', () => this.sweep());
    this.jobs.schedule('jobs.sweep', { cron: '*/5 * * * *' });
  }

  async sweep(now = new Date()): Promise<{ requeued: number; failed: number }> {
    let requeued = 0;
    let failed = 0;
    for (const tenantId of await this.engine.allTenantIds()) {
      try {
        const { offers: found, failed: gaveUp } = await this.repo.sweepTenant(tenantId, now);
        failed += gaveUp;
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
