import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { CasesTx } from '../cases/cases-repo.js';
import { Engine } from '../db/engine.js';
import { StatsStore } from './stats-store.mssql.js';
import { InterviewsService } from '../interviews/interviews.service.js';
import { BUS, projectChannel, type Bus } from '../jobs/bus.js';
import { JobsService } from '../jobs/jobs.service.js';

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
    private readonly engine: Engine,
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
    this.interviews.onSubmitted((t, row) =>
      this.touched(t, row.tenantId, row.projectId, new Date()),
    );
  }

  private readonly store = new StatsStore();

  /** Called inside the transaction that changed an interview; the refresh runs after it. */
  async touched(tx: CasesTx, tenantId: string, projectId: string, at: Date): Promise<void> {
    const project = await tx.project(projectId);
    const p = project ? { tz: project.timezone } : undefined;
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
    await this.engine.sql.withTenant(tenantId, async (tx) => {
      const timezone = await this.store.timezone(tx, projectId);
      if (!timezone) return;
      if (day) await this.store.refreshDay(tx, { tenantId, projectId, day, timezone });
      else await this.store.refreshAll(tx, { tenantId, projectId, timezone });
    });
    await this.bus.publish(projectChannel(projectId), { type: 'stats', day });
  }

  /** Nightly: every project of every organisation, from scratch. */
  async recomputeAll(): Promise<number> {
    let n = 0;
    for (const tenantId of await this.engine.allTenantIds()) {
      const ids = (
        await this.engine.sql.withTenant(tenantId, (tx) =>
          tx.selectFrom('projects').select('id').execute(),
        )
      ).map((p) => p.id.toLowerCase());
      for (const id of ids) {
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
