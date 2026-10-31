import { Injectable } from '@nestjs/common';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { sql } from 'drizzle-orm';
import { sql as ksql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { MssqlCasesTx, PgCasesTx, type CasesTx } from '../cases/cases-repo.js';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { COUNTED, COUNTED_SQL } from '../common/statuses.js';
import { Database, type Tx } from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import { localDay } from '../stats/zoned-day.js';

/**
 * The reads behind the live dashboard, whichever engine runs (the pattern of
 * `auth/auth-repo.ts`). A transaction here is also a `CasesTx`.
 */
export interface LiveTx extends CasesTx {
  modeTotals(projectId: string): Promise<{ mode: string; n: number }[]>;
  /** Completes per local day over the last 30 days. */
  recentDays(projectId: string, tz: string): Promise<{ day: string; n: number }[]>;
  /** The latest version of each questionnaire of the project. */
  latestVersions(projectId: string): Promise<{ qid: string; compiled: CompiledQuestionnaire }[]>;
  /** Complete interviews with only the answers and case fields asked for. */
  quotaRows(
    projectId: string,
    refs: string[],
    fields: string[],
  ): Promise<
    {
      qid: string;
      a: Record<string, unknown> | null;
      c: Record<string, unknown> | null;
      mode: string;
    }[]
  >;
  caseStatuses(
    projectId: string,
  ): Promise<{ status: string; disposition: string | null; n: number }[]>;
  callbacksDue(projectId: string): Promise<number>;
  funnel(projectId: string): Promise<{
    total: number;
    sent: number;
    opened: number;
    started: number;
    completed: number;
    bounced: number;
  }>;
  activeInterviewers(
    projectId: string,
    minutes: number,
  ): Promise<
    {
      userId: string;
      name: string;
      mode: string;
      caseId: string | null;
      externalId: string | null;
      lastAt: Date;
    }[]
  >;
}

export interface LiveRepo {
  inTenant<T>(tenantId: string, fn: (t: LiveTx) => Promise<T>): Promise<T>;
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

export class PgLiveTx extends PgCasesTx implements LiveTx {
  constructor(
    private readonly ltx: Tx,
    tenant: string,
    audits: AuditService,
  ) {
    super(ltx, tenant, audits);
  }

  async modeTotals(projectId: string) {
    return (await this.ltx.execute(sql`
      select mode, sum(completes)::int as n from stats_daily where project_id = ${projectId} group by 1`)) as unknown as {
      mode: string;
      n: number;
    }[];
  }

  async recentDays(projectId: string, tz: string) {
    return (await this.ltx.execute(sql`
      select to_char(day, 'YYYY-MM-DD') as day, sum(completes)::int as n from stats_daily
      where project_id = ${projectId} and day > (now() at time zone ${tz})::date - 30
      group by 1 order by 1`)) as unknown as { day: string; n: number }[];
  }

  async latestVersions(projectId: string) {
    return (await this.ltx.execute(sql`
      select distinct on (v.questionnaire_id) v.questionnaire_id as qid, v.compiled
      from questionnaire_versions v
      join questionnaires q on q.id = v.questionnaire_id
      where q.project_id = ${projectId} order by v.questionnaire_id, v.version desc`)) as unknown as {
      qid: string;
      compiled: CompiledQuestionnaire;
    }[];
  }

  async quotaRows(projectId: string, refs: string[], fields: string[]) {
    return (await this.ltx.execute(sql`
        select v.questionnaire_id as qid,
               (select jsonb_object_agg(key, value) from jsonb_each(i.answers)
                where key in ${refs.length ? refs : ['']}) as a,
               (select jsonb_object_agg(key, value) from jsonb_each(
                  case when jsonb_typeof(i.context->'case') = 'object'
                       then i.context->'case' else '{}'::jsonb end)
                where key in ${fields.length ? fields : ['']}) as c,
               i.mode
        from interviews i join questionnaire_versions v on v.id = i.questionnaire_version_id
        where i.project_id = ${projectId} and i.entry_pass = 1 and i.disposition = 'COMPLETE'
          and i.status in ${COUNTED_SQL}`)) as unknown as Awaited<ReturnType<LiveTx['quotaRows']>>;
  }

  async caseStatuses(projectId: string) {
    return (await this.ltx.execute(sql`
      select status, disposition, count(*)::int as n from cases where project_id = ${projectId} group by 1, 2`)) as unknown as {
      status: string;
      disposition: string | null;
      n: number;
    }[];
  }

  async callbacksDue(projectId: string) {
    const r = (await this.ltx.execute(sql`
      select count(*)::int as n from cases where project_id = ${projectId}
        and status not in ('finalised', 'withdrawn') and next_contact_at is not null and next_contact_at <= now()`)) as unknown as {
      n: number;
    }[];
    return r[0]?.n ?? 0;
  }

  async funnel(projectId: string) {
    const r = (await this.ltx.execute(sql`
      select count(*)::int as total, count(sent_at)::int as sent, count(opened_at)::int as opened,
             count(started_at)::int as started, count(completed_at)::int as completed,
             count(*) filter (where bounce_type = 'hard')::int as bounced
      from invitations where project_id = ${projectId}`)) as unknown as Awaited<
      ReturnType<LiveTx['funnel']>
    >[];
    return r[0]!;
  }

  async activeInterviewers(projectId: string, minutes: number) {
    return (await this.ltx.execute(sql`
      select distinct on (i.interviewer_id) i.interviewer_id as "userId", u.name, i.mode,
             i.case_id as "caseId", c.external_id as "externalId", i.updated_at as "lastAt"
      from interviews i join users u on u.id = i.interviewer_id
      left join cases c on c.id = i.case_id
      where i.project_id = ${projectId} and i.interviewer_id is not null
        and i.updated_at > now() - make_interval(mins => ${minutes})
      order by i.interviewer_id, i.updated_at desc`)) as unknown as Awaited<
      ReturnType<LiveTx['activeInterviewers']>
    >;
  }
}

@Injectable()
export class PgLiveRepo implements LiveRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  inTenant<T>(tenantId: string, fn: (t: LiveTx) => Promise<T>) {
    return this.database.withTenant(tenantId, (tx) => fn(new PgLiveTx(tx, tenantId, this.audits)));
  }
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const lowOrNull = (s: string | null) => (s === null ? null : s.toLowerCase());
const pick = (obj: unknown, keys: string[]) => {
  if (!obj || typeof obj !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in (obj as object)) out[k] = (obj as Record<string, unknown>)[k];
  return Object.keys(out).length ? out : null;
};

export class MssqlLiveTx extends MssqlCasesTx implements LiveTx {
  constructor(
    private readonly xtx: MssqlTx,
    tn: string,
    cstore: CasesStore,
  ) {
    super(xtx, tn, cstore);
  }

  async modeTotals(projectId: string) {
    const rows = await this.xtx
      .selectFrom('stats_daily')
      .select(['mode', ksql<number>`SUM(completes)`.as('n')])
      .where('project_id', '=', projectId)
      .groupBy('mode')
      .execute();
    return rows.map((r) => ({ mode: r.mode, n: r.n }));
  }

  async recentDays(projectId: string, tz: string) {
    // 30 local days before today, computed here (the zone is an IANA name).
    const today = localDay(new Date(), tz);
    const since = new Date(`${today}T00:00:00Z`);
    since.setUTCDate(since.getUTCDate() - 30);
    const res = await ksql<{ day: string; n: number }>`
      SELECT CONVERT(varchar(10), day, 23) AS day, SUM(completes) AS n FROM dbo.stats_daily
      WHERE project_id = ${projectId} AND day > ${since.toISOString().slice(0, 10)}
      GROUP BY day ORDER BY day`.execute(this.xtx);
    return res.rows;
  }

  async latestVersions(projectId: string) {
    const res = await ksql<{ qid: string; compiled: string }>`
      SELECT qid, compiled FROM (
        SELECT v.questionnaire_id AS qid, v.compiled,
          ROW_NUMBER() OVER (PARTITION BY v.questionnaire_id ORDER BY v.version DESC) AS rn
        FROM dbo.questionnaire_versions v JOIN dbo.questionnaires q ON q.id = v.questionnaire_id
        WHERE q.project_id = ${projectId}
      ) t WHERE rn = 1`.execute(this.xtx);
    return res.rows.map((r) => ({
      qid: low(r.qid),
      compiled: JSON.parse(r.compiled) as CompiledQuestionnaire,
    }));
  }

  async quotaRows(projectId: string, refs: string[], fields: string[]) {
    const counted = ksql.join(COUNTED.map((s) => ksql`${s}`));
    const res = await ksql<{ qid: string; answers: string; context: string; mode: string }>`
      SELECT v.questionnaire_id AS qid, i.answers, i.context, i.mode
      FROM dbo.interviews i JOIN dbo.questionnaire_versions v ON v.id = i.questionnaire_version_id
      WHERE i.project_id = ${projectId} AND i.entry_pass = 1 AND i.disposition = 'COMPLETE'
        AND i.status IN (${counted})`.execute(this.xtx);
    return res.rows.map((r) => ({
      qid: low(r.qid),
      a: pick(JSON.parse(r.answers), refs),
      c: pick((JSON.parse(r.context) as { case?: unknown }).case, fields),
      mode: r.mode,
    }));
  }

  async caseStatuses(projectId: string) {
    const rows = await this.xtx
      .selectFrom('cases')
      .select(['status', 'disposition', ksql<number>`COUNT(*)`.as('n')])
      .where('project_id', '=', projectId)
      .groupBy(['status', 'disposition'])
      .execute();
    return rows.map((r) => ({ status: r.status, disposition: r.disposition, n: r.n }));
  }

  async callbacksDue(projectId: string) {
    const r = await this.xtx
      .selectFrom('cases')
      .select(ksql<number>`COUNT(*)`.as('n'))
      .where('project_id', '=', projectId)
      .where('status', 'not in', ['finalised', 'withdrawn'])
      .where('next_contact_at', 'is not', null)
      .where('next_contact_at', '<=', ksql<Date>`SYSDATETIMEOFFSET()`)
      .executeTakeFirstOrThrow();
    return r.n;
  }

  async funnel(projectId: string) {
    const res = await ksql<Awaited<ReturnType<LiveTx['funnel']>>>`
      SELECT COUNT(*) AS total, COUNT(sent_at) AS sent, COUNT(opened_at) AS opened,
             COUNT(started_at) AS started, COUNT(completed_at) AS completed,
             SUM(CASE WHEN bounce_type = 'hard' THEN 1 ELSE 0 END) AS bounced
      FROM dbo.invitations WHERE project_id = ${projectId}`.execute(this.xtx);
    const r = res.rows[0]!;
    return { ...r, bounced: r.bounced ?? 0 };
  }

  async activeInterviewers(projectId: string, minutes: number) {
    const since = new Date(Date.now() - minutes * 60_000);
    const res = await ksql<{
      user_id: string;
      name: string;
      mode: string;
      case_id: string | null;
      external_id: string | null;
      last_at: Date;
    }>`
      SELECT user_id, name, mode, case_id, external_id, last_at FROM (
        SELECT i.interviewer_id AS user_id, u.name, i.mode, i.case_id, c.external_id,
          i.updated_at AS last_at,
          ROW_NUMBER() OVER (PARTITION BY i.interviewer_id ORDER BY i.updated_at DESC) AS rn
        FROM dbo.interviews i JOIN dbo.users u ON u.id = i.interviewer_id
        LEFT JOIN dbo.cases c ON c.id = i.case_id
        WHERE i.project_id = ${projectId} AND i.interviewer_id IS NOT NULL
          AND i.updated_at > ${instant(since)}
      ) t WHERE rn = 1 ORDER BY user_id`.execute(this.xtx);
    return res.rows.map((r) => ({
      userId: low(r.user_id),
      name: r.name,
      mode: r.mode,
      caseId: lowOrNull(r.case_id),
      externalId: r.external_id,
      lastAt: r.last_at,
    }));
  }
}

@Injectable()
export class MssqlLiveRepo implements LiveRepo {
  private readonly cstore = new CasesStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: LiveTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlLiveTx(tx, tenantId, this.cstore)),
    );
  }
}

export const LIVE_REPO = Symbol('LIVE_REPO');
