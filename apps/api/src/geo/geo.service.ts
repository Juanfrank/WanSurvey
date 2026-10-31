import { Inject, Injectable, Logger } from '@nestjs/common';
import { CASES_REPO, type CasesRepo } from '../cases/cases-repo.js';
import { GEOCODER, type Geocoder } from './geocoder.js';

export interface GeocodeJob {
  running: boolean;
  total: number;
  done: number;
  found: number;
  notFound: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

/**
 * Geocodes a project's address contacts in the background, one job per project at a time.
 * Jobs live in this process for now; the worker service takes them over in a later slice.
 */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);
  private readonly jobs = new Map<string, GeocodeJob>();

  constructor(
    @Inject(CASES_REPO) private readonly repo: CasesRepo,
    @Inject(GEOCODER) readonly geocoder: Geocoder | null,
  ) {}

  status(projectId: string): GeocodeJob | null {
    return this.jobs.get(projectId) ?? null;
  }

  /** Address contacts of the project not geocoded yet (or all, when `again`). */
  pending(tenantId: string, projectId: string, limit: number, again = false) {
    return this.repo.inTenant(tenantId, (t) => t.pendingAddresses(projectId, limit, again));
  }

  /** Starts a job over the given contacts; returns at once. */
  start(tenantId: string, projectId: string, todo: { id: string; value: string }[]): GeocodeJob {
    const job: GeocodeJob = {
      running: true,
      total: todo.length,
      done: 0,
      found: 0,
      notFound: 0,
      failed: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    this.jobs.set(projectId, job);
    void this.run(tenantId, job, todo);
    return job;
  }

  private async run(tenantId: string, job: GeocodeJob, todo: { id: string; value: string }[]) {
    const geocoder = this.geocoder!;
    for (const c of todo) {
      try {
        const point = await geocoder.geocode(c.value);
        await this.repo.inTenant(tenantId, (t) => t.setGeocode(c.id, point));
        if (point) job.found++;
        else job.notFound++;
      } catch (e) {
        job.failed++;
        job.error = (e as Error).message;
        this.logger.warn(`Geocoding failed: ${job.error}`);
      }
      job.done++;
    }
    job.running = false;
    job.finishedAt = new Date().toISOString();
  }
}
