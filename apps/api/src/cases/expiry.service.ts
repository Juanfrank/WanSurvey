import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Engine } from '../db/engine.js';
import { JobsService } from '../jobs/jobs.service.js';
import { CASES_REPO, type CasesRepo, type CasesTx } from './cases-repo.js';
import { CasesService } from './cases.service.js';

/**
 * Cases have a deadline after assignment (project setting `fieldwork.caseExpiryDays`): when it
 * passes without a final result, the case closes as EXPIRED and leaves the work lists. Cases on
 * a device, being called or interviewed are left until that ends. Runs every hour.
 */
@Injectable()
export class ExpiryService implements OnModuleInit {
  private readonly logger = new Logger('Expiry');

  constructor(
    private readonly engine: Engine,
    @Inject(CASES_REPO) private readonly repo: CasesRepo,
    private readonly cases: CasesService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register('cases.expiry', () => this.expireAll());
    this.jobs.schedule('cases.expiry', { cron: '5 * * * *' });
  }

  async expireAll(now = new Date()): Promise<number> {
    let n = 0;
    for (const tenantId of await this.engine.allTenantIds()) {
      try {
        n += await this.repo.inTenant(tenantId, async (t) => {
          let m = 0;
          for (const id of await t.projectIds()) m += await this.expireProject(t, id, now);
          return m;
        });
      } catch (e) {
        this.logger.error(`Expiry failed for ${tenantId}: ${(e as Error).message}`);
      }
    }
    return n;
  }

  /** Closes the project's overdue cases; returns how many. */
  async expireProject(t: CasesTx, projectId: string, now = new Date()) {
    const days = (await this.cases.settings(t, projectId)).fieldwork.caseExpiryDays;
    if (!days) return 0;
    const due = await t.expireDue(projectId, now, days);
    await t.events(
      due.map((c) => ({
        caseId: c.id,
        type: 'expired',
        details: { days, assignedTo: c.assignedTo, assignedAt: c.assignedAt },
      })),
    );
    return due.length;
  }
}
