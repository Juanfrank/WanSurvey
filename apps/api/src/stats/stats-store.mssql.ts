import { sql } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';
import { COUNTED } from '../review/review-store.mssql.js';
import { dayBounds, localDay, nextDay } from './zoned-day.js';

/**
 * Daily figures on SQL Server (Kysely): completed interviews per project, local day, mode and
 * interviewer, for `stats.service.ts`. Takes the transaction of `MssqlDatabase.withTenant`. A day's bounds are instants worked out from
 * the project's IANA time zone (zoned-day.ts); the database never converts zones.
 */
export class StatsStore {
  /** A project's time zone (IANA), or undefined when it does not exist. */
  async timezone(tx: MssqlTx, projectId: string): Promise<string | undefined> {
    const r = await tx
      .selectFrom('projects')
      .select('timezone')
      .where('id', '=', projectId)
      .executeTakeFirst();
    return r?.timezone;
  }

  /** Recomputes one local day of a project from its interviews. */
  async refreshDay(
    tx: MssqlTx,
    v: { tenantId: string; projectId: string; day: string; timezone: string },
  ): Promise<void> {
    const { from, to } = dayBounds(v.day, v.timezone);
    await tx
      .deleteFrom('stats_daily')
      .where('project_id', '=', v.projectId)
      .where('day', '=', v.day)
      .execute();
    await sql`
      INSERT INTO dbo.stats_daily (tenant_id, project_id, day, mode, interviewer_id, submitted,
        completes, approved, rejected, active_ms)
      SELECT ${v.tenantId}, ${v.projectId}, ${v.day}, i.mode, i.interviewer_id,
        SUM(CASE WHEN i.status <> 'returned' THEN 1 ELSE 0 END),
        SUM(CASE WHEN i.status IN (${sql.join(COUNTED)}) AND i.disposition = 'COMPLETE' THEN 1 ELSE 0 END),
        SUM(CASE WHEN i.status = 'approved' THEN 1 ELSE 0 END),
        SUM(CASE WHEN i.status = 'rejected' THEN 1 ELSE 0 END),
        COALESCE(SUM(CASE WHEN i.status IN (${sql.join(COUNTED)}) AND i.disposition = 'COMPLETE'
                          THEN CAST(i.active_ms AS bigint) ELSE 0 END), 0)
      FROM dbo.interviews i
      WHERE i.project_id = ${v.projectId} AND i.submitted_at IS NOT NULL AND i.entry_pass = 1
        AND i.status IN ('submitted', 'in_review', 'approved', 'rejected', 'returned')
        AND i.submitted_at >= ${from.toISOString()} AND i.submitted_at < ${to.toISOString()}
      GROUP BY i.mode, i.interviewer_id`.execute(tx);
  }

  /** Recomputes every day of a project from scratch (the nightly job). Returns the days done. */
  async refreshAll(
    tx: MssqlTx,
    v: { tenantId: string; projectId: string; timezone: string },
  ): Promise<number> {
    const range = await tx
      .selectFrom('interviews')
      .select([
        sql<Date | null>`MIN(submitted_at)`.as('first'),
        sql<Date | null>`MAX(submitted_at)`.as('last'),
      ])
      .where('project_id', '=', v.projectId)
      .where('submitted_at', 'is not', null)
      .executeTakeFirstOrThrow();
    await tx.deleteFrom('stats_daily').where('project_id', '=', v.projectId).execute();
    if (!range.first || !range.last) return 0;
    let n = 0;
    const end = localDay(range.last, v.timezone);
    for (let day = localDay(range.first, v.timezone); day <= end; day = nextDay(day)) {
      await this.refreshDay(tx, { ...v, day });
      n++;
    }
    return n;
  }

  /** The figures between two local days (inclusive), days as YYYY-MM-DD. */
  async daily(
    tx: MssqlTx,
    v: { projectId: string; from?: string; to?: string; mode?: string; interviewerId?: string },
  ) {
    const res = await sql<{
      day: string;
      mode: string;
      interviewer_id: string | null;
      submitted: number;
      completes: number;
      approved: number;
      rejected: number;
      active_ms: number;
    }>`
      SELECT CONVERT(varchar(10), day, 23) AS day, mode, interviewer_id, submitted, completes,
        approved, rejected, active_ms
      FROM dbo.stats_daily
      WHERE project_id = ${v.projectId}
        ${v.from ? sql`AND day >= ${v.from}` : sql``}
        ${v.to ? sql`AND day <= ${v.to}` : sql``}
        ${v.mode ? sql`AND mode = ${v.mode}` : sql``}
        ${v.interviewerId ? sql`AND interviewer_id = ${v.interviewerId}` : sql``}
      ORDER BY day, mode, interviewer_id`.execute(tx);
    return res.rows.map((r) => ({
      ...r,
      interviewer_id: r.interviewer_id?.toLowerCase() ?? null,
      active_ms: Number(r.active_ms),
    }));
  }

  /** Totals of a project over a range of local days. */
  async totals(tx: MssqlTx, v: { projectId: string; from?: string; to?: string }) {
    const res = await sql<{
      submitted: number | null;
      completes: number | null;
      approved: number | null;
      rejected: number | null;
      active_ms: number | null;
    }>`
      SELECT SUM(submitted) AS submitted, SUM(completes) AS completes, SUM(approved) AS approved,
        SUM(rejected) AS rejected, SUM(active_ms) AS active_ms
      FROM dbo.stats_daily
      WHERE project_id = ${v.projectId}
        ${v.from ? sql`AND day >= ${v.from}` : sql``} ${v.to ? sql`AND day <= ${v.to}` : sql``}`.execute(
      tx,
    );
    const r = res.rows[0]!;
    return {
      submitted: r.submitted ?? 0,
      completes: r.completes ?? 0,
      approved: r.approved ?? 0,
      rejected: r.rejected ?? 0,
      activeMs: Number(r.active_ms ?? 0),
    };
  }
}
