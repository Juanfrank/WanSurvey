import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { Database, type Tx } from '../db/database.js';
import { cases, projects } from '../db/schema.js';
import { JobsService } from '../jobs/jobs.service.js';
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
    private readonly database: Database,
    private readonly cases: CasesService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register('cases.expiry', () => this.expireAll());
    this.jobs.schedule('cases.expiry', { cron: '5 * * * *' });
  }

  async expireAll(now = new Date()): Promise<number> {
    let n = 0;
    for (const tenantId of await this.database.allTenantIds()) {
      try {
        n += await this.database.withTenant(tenantId, async (tx) => {
          let m = 0;
          for (const p of await tx.select({ id: projects.id }).from(projects))
            m += await this.expireProject(tx, tenantId, p.id, now);
          return m;
        });
      } catch (e) {
        this.logger.error(`Expiry failed for ${tenantId}: ${(e as Error).message}`);
      }
    }
    return n;
  }

  /** Closes the project's overdue cases; returns how many. */
  async expireProject(tx: Tx, tenantId: string, projectId: string, now = new Date()) {
    const days = (await this.cases.settings(tx, projectId)).fieldwork.caseExpiryDays;
    if (!days) return 0;
    const due = await tx
      .update(cases)
      .set({
        status: 'finalised',
        disposition: 'EXPIRED',
        nextContactAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(cases.projectId, projectId),
          inArray(cases.status, ['assigned', 'in_progress']),
          isNotNull(cases.assignedTo),
          lt(cases.assignedAt, new Date(now.getTime() - days * 86_400_000)),
          isNull(cases.checkedOutDevice),
          or(isNull(cases.callLockUntil), lt(cases.callLockUntil, now)),
          sql`not exists (select 1 from interviews iv where iv.case_id = ${cases.id}
                and iv.status = 'in_progress')`,
        ),
      )
      .returning({ id: cases.id, assignedTo: cases.assignedTo, assignedAt: cases.assignedAt });
    await this.cases.events(
      tx,
      tenantId,
      null,
      due.map((c) => ({
        caseId: c.id,
        type: 'expired',
        details: { days, assignedTo: c.assignedTo, assignedAt: c.assignedAt },
      })),
    );
    return due.length;
  }
}
