import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { Database, type Tx } from '../db/database.js';
import { projects, statsDaily } from '../db/schema.js';
import { InterviewsService } from '../interviews/interviews.service.js';
import { BUS, projectChannel, type Bus } from '../jobs/bus.js';
import { JobsService } from '../jobs/jobs.service.js';
import { COUNTED_SQL } from '../common/statuses.js';

export { COUNTED } from '../common/statuses.js';

/** One formatter per time zone: building one is far slower than using it. */
const dayFormats = new Map<string, Intl.DateTimeFormat | null>();

/** The calendar day of `at` in a time zone, as YYYY-MM-DD. */
export function localDay(at: Date, timeZone: string): string {
  let f = dayFormats.get(timeZone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone });
    } catch {
      f = null;
    }
    dayFormats.set(timeZone, f);
  }
  return f ? f.format(at) : at.toISOString().slice(0, 10);
}

/**
 * Daily figures per project, mode and interviewer (M3). A submission or a review decision
 * enqueues a refresh of that day (debounced by job id), the worker recomputes the day from the
 * interviews and announces the change, and a nightly job recomputes everything to fix drift.
 */
/** Submissions within this window share one refresh of the day's figures. */
const REFRESH_WINDOW_MS = 5000;

@Injectable()
export class StatsService implements OnModuleInit {
  private readonly logger = new Logger('Stats');

  constructor(
    private readonly database: Database,
    private readonly jobs: JobsService,
    private readonly interviews: InterviewsService,
    @Inject(BUS) private readonly bus: Bus,
  ) {}

  onModuleInit() {
    this.jobs.register('stats.refresh', (d) =>
      this.refresh(d.tenantId as string, d.projectId as string, (d.day as string | null) ?? null),
    );
    this.jobs.register('stats.nightly', () => this.recomputeAll());
    this.jobs.schedule('stats.nightly', { cron: '0 2 * * *' });
    this.interviews.onSubmitted((tx, row) =>
      this.touched(tx, row.tenantId, row.projectId, new Date()),
    );
  }

  /** Called inside the transaction that changed an interview; the refresh runs after it. */
  async touched(tx: Tx, tenantId: string, projectId: string, at: Date): Promise<void> {
    const [p] = await tx
      .select({ tz: projects.timezone })
      .from(projects)
      .where(eq(projects.id, projectId));
    const day = localDay(at, p?.tz ?? 'UTC');
    // At most one refresh per project day every few seconds. The id changes with the time
    // window, so a refresh already running (or one that failed) never swallows later ones; it
    // is queued without waiting on Redis, and the nightly recompute covers a lost one.
    void this.jobs.offer(
      'stats.refresh',
      { tenantId, projectId, day },
      { jobId: `${projectId}.${day}.${Math.floor(Date.now() / REFRESH_WINDOW_MS)}`, delayMs: 1000 },
    );
  }

  /** Recomputes one day of a project (or every day, with `day` null) and announces it. */
  async refresh(tenantId: string, projectId: string, day: string | null): Promise<void> {
    await this.database.withTenant(tenantId, async (tx) => {
      const [p] = await tx
        .select({ tz: projects.timezone })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!p) return;
      const localDate = sql`(i.submitted_at at time zone ${p.tz})::date`;
      await tx
        .delete(statsDaily)
        .where(
          day
            ? and(eq(statsDaily.projectId, projectId), eq(statsDaily.day, day))
            : eq(statsDaily.projectId, projectId),
        );
      await tx.execute(sql`
        insert into stats_daily (tenant_id, project_id, day, mode, interviewer_id, submitted, completes, approved, rejected, active_ms)
        select ${tenantId}::uuid, ${projectId}::uuid, ${localDate}, i.mode, i.interviewer_id,
               count(*) filter (where i.status <> 'returned'),
               count(*) filter (where i.status in ${COUNTED_SQL} and i.disposition = 'COMPLETE'),
               count(*) filter (where i.status = 'approved'),
               count(*) filter (where i.status = 'rejected'),
               coalesce(sum(i.active_ms) filter (where i.status in ${COUNTED_SQL} and i.disposition = 'COMPLETE'), 0)
        from interviews i
        where i.project_id = ${projectId} and i.submitted_at is not null and i.entry_pass = 1
          and i.status in ('submitted', 'in_review', 'approved', 'rejected', 'returned')
          ${
            // A range on the column itself, so the (project_id, submitted_at) index serves it.
            day
              ? sql`and i.submitted_at >= (${day}::date)::timestamp at time zone ${p.tz}
                    and i.submitted_at < (${day}::date + 1)::timestamp at time zone ${p.tz}`
              : sql``
          }
        group by 3, 4, 5`);
    });
    await this.bus.publish(projectChannel(projectId), { type: 'stats', day });
  }

  /** Nightly: every project of every organisation, from scratch. */
  async recomputeAll(): Promise<number> {
    let n = 0;
    for (const tenantId of await this.database.allTenantIds()) {
      const ids = await this.database.withTenant(tenantId, (tx) =>
        tx.select({ id: projects.id }).from(projects),
      );
      for (const { id } of ids) {
        try {
          await this.refresh(tenantId, id, null);
          n++;
        } catch (e) {
          this.logger.error(`Recompute failed for project ${id}: ${(e as Error).message}`);
        }
      }
    }
    return n;
  }
}
