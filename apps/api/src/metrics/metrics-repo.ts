import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { sql as ksql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { MssqlCasesTx, PgCasesTx, type CasesTx } from '../cases/cases-repo.js';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { COUNTED, COUNTED_SQL } from '../common/statuses.js';
import { Database, type Tx } from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import { interviewerGoals, users } from '../db/schema.js';
import { dayStart, nextDay } from '../stats/zoned-day.js';

/**
 * The database side of goals and interviewer metrics, whichever engine runs (the pattern of
 * `auth/auth-repo.ts`). A transaction here is also a `CasesTx`.
 */
export type GoalRow = typeof interviewerGoals.$inferSelect;

export interface GoalListRow {
  id: string;
  userId: string | null;
  name: string | null;
  frequency: string;
  questionnaireId: string | null;
  startsOn: string;
  endsOn: string;
  target: number;
}

export interface MetricsFilter {
  projectId: string;
  from?: string;
  to?: string;
  mode?: string;
  /** Only this person's figures (no team view). */
  userId?: string;
  timezone: string;
}

export interface MetricsTx extends CasesTx {
  // Goals
  goals(projectId: string, scope: { userId?: string }): Promise<GoalListRow[]>;
  goalCompletes(
    projectId: string,
    g: { userId: string | null; questionnaireId: string | null },
    from: string,
    to: string,
    tz: string,
  ): Promise<number>;
  insertGoal(v: {
    projectId: string;
    userId: string | null;
    frequency: string;
    questionnaireId: string | null;
    startsOn: string;
    endsOn: string;
    target: number;
    createdBy: string;
  }): Promise<GoalRow>;
  goal(projectId: string, id: string): Promise<GoalRow | null>;
  updateGoal(
    id: string,
    patch: { frequency?: string; startsOn?: string; endsOn?: string; target?: number },
  ): Promise<GoalRow>;
  deleteGoal(projectId: string, id: string): Promise<boolean>;

  // Metrics
  statsDaily(f: MetricsFilter): Promise<
    {
      id: string;
      day: string;
      submitted: number;
      completes: number;
      approved: number;
      rejected: number;
    }[]
  >;
  completeInterviews(f: MetricsFilter): Promise<
    {
      id: string;
      active_ms: number;
      items: number;
      specials: number;
      speeding: boolean;
      straight: boolean;
      back: number;
    }[]
  >;
  dialCounts(f: MetricsFilter): Promise<{ id: string; n: number }[]>;
  workedCases(f: MetricsFilter): Promise<{ id: string; disposition: string | null }[]>;
  syncLatency(f: MetricsFilter): Promise<{ id: string; s: number | null }[]>;
  userNames(ids: string[]): Promise<{ id: string; name: string }[]>;
}

export interface MetricsRepo {
  inTenant<T>(tenantId: string, fn: (t: MetricsTx) => Promise<T>): Promise<T>;
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

export class PgMetricsTx extends PgCasesTx implements MetricsTx {
  constructor(
    private readonly mtx: Tx,
    tenant: string,
    audits: AuditService,
  ) {
    super(mtx, tenant, audits);
    this.tenantId2 = tenant;
  }
  private readonly tenantId2: string;

  goals(projectId: string, scope: { userId?: string }) {
    return this.mtx
      .select({
        id: interviewerGoals.id,
        userId: interviewerGoals.userId,
        name: users.name,
        frequency: interviewerGoals.frequency,
        questionnaireId: interviewerGoals.questionnaireId,
        startsOn: interviewerGoals.startsOn,
        endsOn: interviewerGoals.endsOn,
        target: interviewerGoals.target,
      })
      .from(interviewerGoals)
      .leftJoin(users, eq(users.id, interviewerGoals.userId))
      .where(
        and(
          eq(interviewerGoals.projectId, projectId),
          // Without the team's metrics: one's own goals and the team's.
          scope.userId
            ? or(eq(interviewerGoals.userId, scope.userId), isNull(interviewerGoals.userId))
            : undefined,
        ),
      )
      .orderBy(asc(interviewerGoals.startsOn), asc(users.name));
  }

  async goalCompletes(
    projectId: string,
    g: { userId: string | null; questionnaireId: string | null },
    from: string,
    to: string,
    tz: string,
  ) {
    const [r] = (await this.mtx.execute(sql`
      select count(*)::int as n
      from interviews i
      join questionnaire_versions v on v.id = i.questionnaire_version_id
      where i.project_id = ${projectId}
        ${g.userId ? sql`and i.interviewer_id = ${g.userId}` : sql``}
        and i.disposition = 'COMPLETE'
        and i.status in ('submitted', 'in_review', 'approved', 'returned')
        -- A paper form keyed twice is one complete (as in the metrics).
        and i.entry_pass = 1
        and i.submitted_at >= (${from}::date)::timestamp at time zone ${tz}
        and i.submitted_at < (${to}::date + 1)::timestamp at time zone ${tz}
        ${g.questionnaireId ? sql`and v.questionnaire_id = ${g.questionnaireId}` : sql``}
    `)) as unknown as { n: number }[];
    return r?.n ?? 0;
  }

  async insertGoal(v: Parameters<MetricsTx['insertGoal']>[0]) {
    const [row] = await this.mtx
      .insert(interviewerGoals)
      .values({ tenantId: this.tenantId2, ...v })
      .returning();
    return row!;
  }

  async goal(projectId: string, id: string) {
    const [g] = await this.mtx
      .select()
      .from(interviewerGoals)
      .where(and(eq(interviewerGoals.id, id), eq(interviewerGoals.projectId, projectId)));
    return g ?? null;
  }

  async updateGoal(id: string, patch: object) {
    const [row] = await this.mtx
      .update(interviewerGoals)
      .set(patch)
      .where(eq(interviewerGoals.id, id))
      .returning();
    return row!;
  }

  async deleteGoal(projectId: string, id: string) {
    const r = await this.mtx
      .delete(interviewerGoals)
      .where(and(eq(interviewerGoals.id, id), eq(interviewerGoals.projectId, projectId)))
      .returning({ id: interviewerGoals.id });
    return r.length > 0;
  }

  private day(col: string, tz: string) {
    return sql`(${sql.raw(col)} at time zone ${tz})::date`;
  }
  private range(col: string, f: MetricsFilter) {
    return sql`${f.from ? sql`and ${this.day(col, f.timezone)} >= ${f.from}::date` : sql``} ${f.to ? sql`and ${this.day(col, f.timezone)} <= ${f.to}::date` : sql``}`;
  }
  private mode(col: string, f: MetricsFilter) {
    return f.mode ? sql`and ${sql.raw(col)} = ${f.mode}` : sql``;
  }
  private who(col: string, f: MetricsFilter) {
    return f.userId ? sql`and ${sql.raw(col)} = ${f.userId}` : sql``;
  }

  async statsDaily(f: MetricsFilter) {
    return (await this.mtx.execute(sql`
      select interviewer_id as id, to_char(day, 'YYYY-MM-DD') as day, sum(submitted)::int as submitted,
             sum(completes)::int as completes, sum(approved)::int as approved, sum(rejected)::int as rejected
      from stats_daily
      where project_id = ${f.projectId} and interviewer_id is not null
        ${f.from ? sql`and day >= ${f.from}::date` : sql``} ${f.to ? sql`and day <= ${f.to}::date` : sql``}
        ${this.mode('mode', f)} ${this.who('interviewer_id', f)}
      group by 1, 2`)) as unknown as Awaited<ReturnType<MetricsTx['statsDaily']>>;
  }

  async completeInterviews(f: MetricsFilter) {
    return (await this.mtx.execute(sql`
      select i.interviewer_id as id, i.active_ms,
             (select count(*)::int from jsonb_each(i.answers)) as items,
             (select count(*)::int from jsonb_each(i.answers) e
               where jsonb_typeof(e.value) = 'object' and e.value ? '$special') as specials,
             i.flags ? 'speeding' as speeding, i.flags ? 'straightlining' as straight,
             (select count(*)::int from interview_paradata pd
               where pd.interview_id = i.id and pd.type = 'navigate_back') as back
      from interviews i
      where i.project_id = ${f.projectId} and i.interviewer_id is not null and i.entry_pass = 1
        and i.status in ${COUNTED_SQL} and i.disposition = 'COMPLETE'
        ${this.range('i.submitted_at', f)} ${this.mode('i.mode', f)} ${this.who('i.interviewer_id', f)}`)) as unknown as Awaited<
      ReturnType<MetricsTx['completeInterviews']>
    >;
  }

  async dialCounts(f: MetricsFilter) {
    return (await this.mtx.execute(sql`
      select interviewer_id as id, count(*)::int as n from call_attempts
      where project_id = ${f.projectId} ${this.range('started_at', f)} ${this.who('interviewer_id', f)}
      group by 1`)) as unknown as { id: string; n: number }[];
  }

  async workedCases(f: MetricsFilter) {
    return (await this.mtx.execute(sql`
      select w.id, c.disposition from (
        select interviewer_id as id, case_id from call_attempts
          where project_id = ${f.projectId} ${this.range('started_at', f)} ${this.who('interviewer_id', f)}
            ${f.mode && f.mode !== 'CATI' ? sql`and false` : sql``}
        union
        select interviewer_id, case_id from interviews
          where project_id = ${f.projectId} and interviewer_id is not null and case_id is not null
            and entry_pass = 1 ${this.range('started_at', f)} ${this.mode('mode', f)} ${this.who('interviewer_id', f)}
      ) w join cases c on c.id = w.case_id`)) as unknown as {
      id: string;
      disposition: string | null;
    }[];
  }

  async syncLatency(f: MetricsFilter) {
    return (await this.mtx.execute(sql`
      select i.interviewer_id as id,
             percentile_cont(0.5) within group (order by extract(epoch from e.received_at - e.at)) as s
      from interview_answer_events e join interviews i on i.id = e.interview_id
      where i.project_id = ${f.projectId} and i.mode = 'CAPI' and i.interviewer_id is not null
        and e.received_at is not null ${this.range('e.at', f)} ${this.who('i.interviewer_id', f)}
      group by 1`)) as unknown as { id: string; s: number | null }[];
  }

  userNames(ids: string[]) {
    return this.mtx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, ids));
  }
}

@Injectable()
export class PgMetricsRepo implements MetricsRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  inTenant<T>(tenantId: string, fn: (t: MetricsTx) => Promise<T>) {
    return this.database.withTenant(tenantId, (tx) =>
      fn(new PgMetricsTx(tx, tenantId, this.audits)),
    );
  }

  /** The same operations inside a transaction someone else opened (modules not yet moved). */
  wrap(tx: Tx, tenantId: string): MetricsTx {
    return new PgMetricsTx(tx, tenantId, this.audits);
  }
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const lowOrNull = (s: string | null) => (s === null ? null : s.toLowerCase());

/** The UTC bounds of a range of local days: from the start of `from` to the end of `to`. */
function bounds(f: MetricsFilter) {
  return {
    from: f.from ? dayStart(f.from, f.timezone) : null,
    to: f.to ? dayStart(nextDay(f.to), f.timezone) : null,
  };
}

function goalRow(r: {
  id: string;
  tenant_id: string;
  project_id: string;
  questionnaire_id: string | null;
  user_id: string | null;
  frequency: string;
  starts_on: string;
  ends_on: string;
  target: number;
  created_by: string | null;
  created_at: Date;
}): GoalRow {
  return {
    id: low(r.id),
    tenantId: low(r.tenant_id),
    projectId: low(r.project_id),
    questionnaireId: lowOrNull(r.questionnaire_id),
    userId: lowOrNull(r.user_id),
    frequency: r.frequency,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    target: r.target,
    createdBy: lowOrNull(r.created_by),
    createdAt: r.created_at,
  } as unknown as GoalRow;
}

const GOAL_COLS = ksql.raw(
  `id, tenant_id, project_id, questionnaire_id, user_id, frequency,
   CONVERT(varchar(10), starts_on, 23) AS starts_on, CONVERT(varchar(10), ends_on, 23) AS ends_on,
   target, created_by, created_at`,
);

export class MssqlMetricsTx extends MssqlCasesTx implements MetricsTx {
  constructor(
    private readonly xtx: MssqlTx,
    private readonly tn: string,
    cstore: CasesStore,
  ) {
    super(xtx, tn, cstore);
  }

  async goals(projectId: string, scope: { userId?: string }) {
    const res = await ksql<{
      id: string;
      user_id: string | null;
      name: string | null;
      frequency: string;
      questionnaire_id: string | null;
      starts_on: string;
      ends_on: string;
      target: number;
    }>`
      SELECT g.id, g.user_id, u.name, g.frequency, g.questionnaire_id,
             CONVERT(varchar(10), g.starts_on, 23) AS starts_on,
             CONVERT(varchar(10), g.ends_on, 23) AS ends_on, g.target
      FROM dbo.interviewer_goals g LEFT JOIN dbo.users u ON u.id = g.user_id
      WHERE g.project_id = ${projectId}
        ${scope.userId ? ksql`AND (g.user_id = ${scope.userId} OR g.user_id IS NULL)` : ksql``}
      ORDER BY g.starts_on, u.name`.execute(this.xtx);
    return res.rows.map((r) => ({
      id: low(r.id),
      userId: lowOrNull(r.user_id),
      name: r.name,
      frequency: r.frequency,
      questionnaireId: lowOrNull(r.questionnaire_id),
      startsOn: r.starts_on,
      endsOn: r.ends_on,
      target: r.target,
    }));
  }

  async goalCompletes(
    projectId: string,
    g: { userId: string | null; questionnaireId: string | null },
    from: string,
    to: string,
    tz: string,
  ) {
    const res = await ksql<{ n: number }>`
      SELECT COUNT(*) AS n
      FROM dbo.interviews i
      JOIN dbo.questionnaire_versions v ON v.id = i.questionnaire_version_id
      WHERE i.project_id = ${projectId}
        ${g.userId ? ksql`AND i.interviewer_id = ${g.userId}` : ksql``}
        AND i.disposition = 'COMPLETE'
        AND i.status IN ('submitted', 'in_review', 'approved', 'returned')
        AND i.entry_pass = 1
        AND i.submitted_at >= ${instant(dayStart(from, tz))}
        AND i.submitted_at < ${instant(dayStart(nextDay(to), tz))}
        ${g.questionnaireId ? ksql`AND v.questionnaire_id = ${g.questionnaireId}` : ksql``}`.execute(
      this.xtx,
    );
    return res.rows[0]?.n ?? 0;
  }

  async insertGoal(v: Parameters<MetricsTx['insertGoal']>[0]) {
    const id = randomUUID();
    await this.xtx
      .insertInto('interviewer_goals')
      .values({
        id,
        tenant_id: this.tn,
        project_id: v.projectId,
        questionnaire_id: v.questionnaireId,
        user_id: v.userId,
        frequency: v.frequency,
        starts_on: v.startsOn,
        ends_on: v.endsOn,
        target: v.target,
        created_by: v.createdBy,
      })
      .execute();
    return (await this.goal(v.projectId, id))!;
  }

  async goal(projectId: string, id: string) {
    const res = await ksql<Parameters<typeof goalRow>[0]>`
      SELECT ${GOAL_COLS} FROM dbo.interviewer_goals
      WHERE id = ${id} AND project_id = ${projectId}`.execute(this.xtx);
    return res.rows[0] ? goalRow(res.rows[0]) : null;
  }

  async updateGoal(
    id: string,
    patch: { frequency?: string; startsOn?: string; endsOn?: string; target?: number },
  ) {
    const set = {
      ...(patch.frequency !== undefined ? { frequency: patch.frequency } : {}),
      ...(patch.startsOn !== undefined ? { starts_on: patch.startsOn } : {}),
      ...(patch.endsOn !== undefined ? { ends_on: patch.endsOn } : {}),
      ...(patch.target !== undefined ? { target: patch.target } : {}),
    };
    if (Object.keys(set).length)
      await this.xtx.updateTable('interviewer_goals').set(set).where('id', '=', id).execute();
    const res = await ksql<Parameters<typeof goalRow>[0]>`
      SELECT ${GOAL_COLS} FROM dbo.interviewer_goals WHERE id = ${id}`.execute(this.xtx);
    return goalRow(res.rows[0]!);
  }

  async deleteGoal(projectId: string, id: string) {
    const r = await this.xtx
      .deleteFrom('interviewer_goals')
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return Number(r.numDeletedRows) > 0;
  }

  private range(col: string, f: MetricsFilter) {
    const b = bounds(f);
    return ksql`${b.from ? ksql`AND ${ksql.raw(col)} >= ${instant(b.from)}` : ksql``}
      ${b.to ? ksql`AND ${ksql.raw(col)} < ${instant(b.to)}` : ksql``}`;
  }
  private mode(col: string, f: MetricsFilter) {
    return f.mode ? ksql`AND ${ksql.raw(col)} = ${f.mode}` : ksql``;
  }
  private who(col: string, f: MetricsFilter) {
    return f.userId ? ksql`AND ${ksql.raw(col)} = ${f.userId}` : ksql``;
  }

  async statsDaily(f: MetricsFilter) {
    const res = await ksql<{
      id: string;
      day: string;
      submitted: number;
      completes: number;
      approved: number;
      rejected: number;
    }>`
      SELECT interviewer_id AS id, CONVERT(varchar(10), day, 23) AS day, SUM(submitted) AS submitted,
             SUM(completes) AS completes, SUM(approved) AS approved, SUM(rejected) AS rejected
      FROM dbo.stats_daily
      WHERE project_id = ${f.projectId} AND interviewer_id IS NOT NULL
        ${f.from ? ksql`AND day >= ${f.from}` : ksql``} ${f.to ? ksql`AND day <= ${f.to}` : ksql``}
        ${this.mode('mode', f)} ${this.who('interviewer_id', f)}
      GROUP BY interviewer_id, day`.execute(this.xtx);
    return res.rows.map((r) => ({ ...r, id: low(r.id) }));
  }

  async completeInterviews(f: MetricsFilter) {
    const counted = ksql.join(COUNTED.map((s) => ksql`${s}`));
    const res = await ksql<{
      id: string;
      active_ms: number;
      items: number;
      specials: number;
      speeding: number;
      straight: number;
      back: number;
    }>`
      SELECT i.interviewer_id AS id, i.active_ms,
        (SELECT COUNT(*) FROM OPENJSON(i.answers)) AS items,
        (SELECT COUNT(*) FROM OPENJSON(i.answers) e
          WHERE e.type = 5 AND JSON_PATH_EXISTS(e.[value], '$."$special"') = 1) AS specials,
        JSON_PATH_EXISTS(i.flags, '$.speeding') AS speeding,
        JSON_PATH_EXISTS(i.flags, '$.straightlining') AS straight,
        (SELECT COUNT(*) FROM dbo.interview_paradata pd
          WHERE pd.interview_id = i.id AND pd.type = 'navigate_back') AS back
      FROM dbo.interviews i
      WHERE i.project_id = ${f.projectId} AND i.interviewer_id IS NOT NULL AND i.entry_pass = 1
        AND i.status IN (${counted}) AND i.disposition = 'COMPLETE'
        ${this.range('i.submitted_at', f)} ${this.mode('i.mode', f)} ${this.who('i.interviewer_id', f)}`.execute(
      this.xtx,
    );
    return res.rows.map((r) => ({
      ...r,
      id: low(r.id),
      speeding: !!r.speeding,
      straight: !!r.straight,
    }));
  }

  async dialCounts(f: MetricsFilter) {
    const res = await ksql<{ id: string; n: number }>`
      SELECT interviewer_id AS id, COUNT(*) AS n FROM dbo.call_attempts
      WHERE project_id = ${f.projectId} ${this.range('started_at', f)} ${this.who('interviewer_id', f)}
      GROUP BY interviewer_id`.execute(this.xtx);
    return res.rows.map((r) => ({ ...r, id: low(r.id) }));
  }

  async workedCases(f: MetricsFilter) {
    const res = await ksql<{ id: string; disposition: string | null }>`
      SELECT w.id, c.disposition FROM (
        SELECT interviewer_id AS id, case_id FROM dbo.call_attempts
          WHERE project_id = ${f.projectId} ${this.range('started_at', f)} ${this.who('interviewer_id', f)}
            ${f.mode && f.mode !== 'CATI' ? ksql`AND 1 = 0` : ksql``}
        UNION
        SELECT interviewer_id, case_id FROM dbo.interviews
          WHERE project_id = ${f.projectId} AND interviewer_id IS NOT NULL AND case_id IS NOT NULL
            AND entry_pass = 1 ${this.range('started_at', f)} ${this.mode('mode', f)} ${this.who('interviewer_id', f)}
      ) w JOIN dbo.cases c ON c.id = w.case_id`.execute(this.xtx);
    return res.rows.map((r) => ({ ...r, id: low(r.id) }));
  }

  async syncLatency(f: MetricsFilter) {
    const res = await ksql<{ id: string; s: number | null }>`
      SELECT DISTINCT i.interviewer_id AS id,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY DATEDIFF_BIG(millisecond, e.at, e.received_at) / 1000.0
        ) OVER (PARTITION BY i.interviewer_id) AS s
      FROM dbo.interview_answer_events e JOIN dbo.interviews i ON i.id = e.interview_id
      WHERE i.project_id = ${f.projectId} AND i.mode = 'CAPI' AND i.interviewer_id IS NOT NULL
        AND e.received_at IS NOT NULL ${this.range('e.at', f)} ${this.who('i.interviewer_id', f)}`.execute(
      this.xtx,
    );
    return res.rows.map((r) => ({ ...r, id: low(r.id) }));
  }

  async userNames(ids: string[]) {
    const rows = await this.xtx
      .selectFrom('users')
      .select(['id', 'name'])
      .where('id', 'in', ids)
      .execute();
    return rows.map((r) => ({ id: low(r.id), name: r.name }));
  }
}

@Injectable()
export class MssqlMetricsRepo implements MetricsRepo {
  private readonly cstore = new CasesStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: MetricsTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlMetricsTx(tx, tenantId, this.cstore)),
    );
  }
}

export const METRICS_REPO = Symbol('METRICS_REPO');
