import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { Database } from '../db/database.js';
import { cases, contacts } from '../db/schema.js';
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
    private readonly database: Database,
    @Inject(GEOCODER) readonly geocoder: Geocoder | null,
  ) {}

  status(projectId: string): GeocodeJob | null {
    return this.jobs.get(projectId) ?? null;
  }

  /** Address contacts of the project not geocoded yet (or all, when `again`). */
  pending(tenantId: string, projectId: string, limit: number, again = false) {
    return this.database.withTenant(tenantId, (tx) =>
      tx
        .select({ id: contacts.id, value: contacts.value })
        .from(contacts)
        .innerJoin(cases, eq(cases.id, contacts.caseId))
        .where(
          and(
            eq(cases.projectId, projectId),
            eq(contacts.type, 'address'),
            ...(again ? [] : [isNull(contacts.geocodedAt)]),
          ),
        )
        .orderBy(asc(contacts.id))
        .limit(limit),
    );
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
        await this.database.withTenant(tenantId, (tx) =>
          tx
            .update(contacts)
            .set({
              lat: point?.lat ?? null,
              lng: point?.lng ?? null,
              geocodeQuality: point?.quality ?? 'not_found',
              geocodedAt: new Date(),
            })
            .where(eq(contacts.id, c.id)),
        );
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
