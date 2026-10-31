import { Injectable } from '@nestjs/common';
import { sql as ksql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { MssqlCasesTx, type CasesTx } from '../cases/cases-repo.js';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { COUNTED } from '../common/statuses.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import { dayStart, nextDay } from '../stats/zoned-day.js';

/**
 * The database side of goals and interviewer metrics, whichever engine runs (the pattern of
 * `auth/auth-repo.ts`). A transaction here is also a `CasesTx`.
 */
export interface GoalRow {
  id: string;
  tenantId: string;
  projectId: string;
  questionnaireId: string | null;
  userId: string | null;
  frequency: string;
  startsOn: string;
  endsOn: string;
  target: number;
  createdBy: string | null;
  createdAt: Date;
}

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
