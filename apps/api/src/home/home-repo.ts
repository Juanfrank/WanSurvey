import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';

/** Counts per project for the home page, read in one transaction of the organisation. */
export interface HomeTx {
  /** Every project of the organisation. */
  projectIds(): Promise<string[]>;
  /** Completes counted so far (the dashboard's figure), per project. */
  completes(): Promise<{ projectId: string; n: number }[]>;
  /** Cases, unassigned fresh cases and callbacks due now, per project. */
  fieldCounts(): Promise<
    { projectId: string; cases: number; unassigned: number; callbacksDue: number }[]
  >;
  /** People with interview activity since an instant, per project. */
  activeSince(since: Date): Promise<{ projectId: string; n: number }[]>;
  /** Interviews waiting for review, and those flagged as too fast, per project. */
  reviewCounts(): Promise<{ projectId: string; toReview: number; tooFast: number }[]>;
  /** One person's open cases, callbacks due now, next callback and returned interviews. */
  mine(userId: string): Promise<
    {
      projectId: string;
      open: number;
      callbacksDue: number;
      nextCallbackAt: Date | null;
      returned: number;
    }[]
  >;
  /**
   * One person's callbacks due now in projects not closed, soonest first; only in `projectIds`
   * when given (null: every project).
   */
  dueCallbacks(
    userId: string,
    projectIds: string[] | null,
    limit: number,
  ): Promise<{ projectId: string; caseId: string; externalId: string | null; at: Date }[]>;
}

export interface HomeRepo {
  inTenant<T>(tenantId: string, fn: (t: HomeTx) => Promise<T>): Promise<T>;
}

const low = (s: string) => s.toLowerCase();
const OPEN = sql`('fresh', 'assigned', 'in_progress')`;
/** The callbacks a person is served (the rail of the Calls tab, without the shared pool). */
const myCallback = (userId: string) => sql`c.disposition = 'CALLBACK' AND c.status IN ${OPEN}
  AND (c.callback_user_id = ${userId} OR (c.callback_user_id IS NULL AND c.assigned_to = ${userId}))`;

export class MssqlHomeTx implements HomeTx {
  constructor(private readonly tx: MssqlTx) {}

  async projectIds() {
    const res = await sql<{ id: string }>`SELECT id FROM projects`.execute(this.tx);
    return res.rows.map((r) => low(r.id));
  }

  async completes() {
    const res = await sql<{ project_id: string; n: number }>`
      SELECT project_id, SUM(completes) AS n FROM stats_daily GROUP BY project_id`.execute(this.tx);
    return res.rows.map((r) => ({ projectId: low(r.project_id), n: r.n ?? 0 }));
  }

  async fieldCounts() {
    const res = await sql<{
      project_id: string;
      cases: number;
      unassigned: number;
      due: number;
    }>`
      SELECT project_id, COUNT(*) AS cases,
        SUM(CASE WHEN status = 'fresh' AND assigned_to IS NULL THEN 1 ELSE 0 END) AS unassigned,
        SUM(CASE WHEN status NOT IN ('finalised', 'withdrawn') AND next_contact_at IS NOT NULL
                  AND next_contact_at <= SYSDATETIMEOFFSET() THEN 1 ELSE 0 END) AS due
      FROM cases GROUP BY project_id`.execute(this.tx);
    return res.rows.map((r) => ({
      projectId: low(r.project_id),
      cases: r.cases,
      unassigned: r.unassigned ?? 0,
      callbacksDue: r.due ?? 0,
    }));
  }

  async activeSince(since: Date) {
    const res = await sql<{ project_id: string; n: number }>`
      SELECT project_id, COUNT(DISTINCT interviewer_id) AS n FROM interviews
      WHERE interviewer_id IS NOT NULL AND updated_at > ${instant(since)}
      GROUP BY project_id`.execute(this.tx);
    return res.rows.map((r) => ({ projectId: low(r.project_id), n: r.n }));
  }

  async reviewCounts() {
    // The review queue's default view: submitted and in review.
    const res = await sql<{ project_id: string; n: number; fast: number }>`
      SELECT project_id, COUNT(*) AS n,
        SUM(CASE WHEN JSON_VALUE(flags, '$.speeding') IS NOT NULL THEN 1 ELSE 0 END) AS fast
      FROM interviews WHERE status IN ('submitted', 'in_review')
      GROUP BY project_id`.execute(this.tx);
    return res.rows.map((r) => ({
      projectId: low(r.project_id),
      toReview: r.n,
      tooFast: r.fast ?? 0,
    }));
  }

  async mine(userId: string) {
    const res = await sql<{
      project_id: string;
      open: number;
      due: number;
      next_at: Date | null;
      returned: number;
    }>`
      SELECT p.id AS project_id,
        (SELECT COUNT(*) FROM cases c
          WHERE c.project_id = p.id AND c.assigned_to = ${userId} AND c.status IN ${OPEN}) AS [open],
        (SELECT COUNT(*) FROM cases c WHERE c.project_id = p.id AND ${myCallback(userId)}
          AND c.next_contact_at <= SYSDATETIMEOFFSET()) AS due,
        (SELECT MIN(c.next_contact_at) FROM cases c WHERE c.project_id = p.id AND ${myCallback(userId)}
          AND c.next_contact_at > SYSDATETIMEOFFSET()) AS next_at,
        (SELECT COUNT(*) FROM interviews i
          WHERE i.project_id = p.id AND i.interviewer_id = ${userId} AND i.status = 'returned') AS returned
      FROM projects p`.execute(this.tx);
    return res.rows.map((r) => ({
      projectId: low(r.project_id),
      open: r.open,
      callbacksDue: r.due,
      nextCallbackAt: r.next_at,
      returned: r.returned,
    }));
  }

  async dueCallbacks(userId: string, projectIds: string[] | null, limit: number) {
    if (projectIds && !projectIds.length) return [];
    const res = await sql<{
      project_id: string;
      id: string;
      external_id: string | null;
      at: Date;
    }>`
      SELECT TOP (${limit}) c.project_id, c.id, c.external_id, c.next_contact_at AS at
      FROM cases c JOIN projects p ON p.id = c.project_id
      WHERE ${myCallback(userId)} AND c.next_contact_at <= SYSDATETIMEOFFSET()
        AND p.status NOT IN ('closed', 'archived')
        ${projectIds ? sql`AND c.project_id IN (${sql.join(projectIds)})` : sql``}
      ORDER BY c.next_contact_at`.execute(this.tx);
    return res.rows.map((r) => ({
      projectId: low(r.project_id),
      caseId: low(r.id),
      externalId: r.external_id,
      at: r.at,
    }));
  }
}

@Injectable()
export class MssqlHomeRepo implements HomeRepo {
  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: HomeTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) => fn(new MssqlHomeTx(tx)));
  }
}

export const HOME_REPO = Symbol('HOME_REPO');
