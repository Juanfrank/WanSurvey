import { Injectable } from '@nestjs/common';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { sql as ksql } from 'kysely';
import { MssqlCasesTx, type CasesTx } from '../cases/cases-repo.js';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { COUNTED } from '../common/statuses.js';
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
  /**
   * Per interviewer, interviews awaiting review (submitted or in review), how many carry a
   * risk flag, and how many of each flag; most flagged first.
   */
  flaggedByInterviewer(projectId: string): Promise<
    {
      userId: string;
      name: string;
      pending: number;
      flagged: number;
      kinds: Partial<Record<(typeof RISK_FLAGS)[number], number>>;
    }[]
  >;
  /** Assigned cases whose deadline (`hours` after assignment) falls within `within` hours. */
  expiringWithin(projectId: string, hours: number, within: number): Promise<number>;
}

/** Quality flags that make an interview risky (the ones `riskOf` weighs). */
export const RISK_FLAGS = [
  'speeding',
  'straightlining',
  'shortPages',
  'positionCluster',
  'farFromAddress',
] as const;

export interface LiveRepo {
  inTenant<T>(tenantId: string, fn: (t: LiveTx) => Promise<T>): Promise<T>;
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
      SELECT CONVERT(varchar(10), day, 23) AS day, SUM(completes) AS n FROM stats_daily
      WHERE project_id = ${projectId} AND day > ${since.toISOString().slice(0, 10)}
      GROUP BY day ORDER BY day`.execute(this.xtx);
    return res.rows;
  }

  async latestVersions(projectId: string) {
    const res = await ksql<{ qid: string; compiled: string }>`
      SELECT qid, compiled FROM (
        SELECT v.questionnaire_id AS qid, v.compiled,
          ROW_NUMBER() OVER (PARTITION BY v.questionnaire_id ORDER BY v.version DESC) AS rn
        FROM questionnaire_versions v JOIN questionnaires q ON q.id = v.questionnaire_id
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
      FROM interviews i JOIN questionnaire_versions v ON v.id = i.questionnaire_version_id
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
      FROM invitations WHERE project_id = ${projectId}`.execute(this.xtx);
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
        FROM interviews i JOIN users u ON u.id = i.interviewer_id
        LEFT JOIN cases c ON c.id = i.case_id
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

  async flaggedByInterviewer(projectId: string) {
    const kinds = ksql.join(RISK_FLAGS.map((k) => ksql`${k}`));
    const res = await ksql<{ user_id: string; name: string; flag: string | null; n: number }>`
      SELECT i.interviewer_id AS user_id, u.name, f.[key] AS flag, COUNT(*) AS n
      FROM interviews i JOIN users u ON u.id = i.interviewer_id
      OUTER APPLY (SELECT [key] FROM OPENJSON(i.flags) WHERE [key] IN (${kinds})) f
      WHERE i.project_id = ${projectId} AND i.status IN ('submitted', 'in_review', 'resubmitted')
      GROUP BY i.interviewer_id, u.name, f.[key]`.execute(this.xtx);
    const flaggedRes = await ksql<{ user_id: string; pending: number; flagged: number }>`
      SELECT i.interviewer_id AS user_id, COUNT(*) AS pending, SUM(f.n) AS flagged
      FROM interviews i
      CROSS APPLY (SELECT CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(i.flags)
        WHERE [key] IN (${kinds})) THEN 1 ELSE 0 END AS n) f
      WHERE i.project_id = ${projectId} AND i.status IN ('submitted', 'in_review', 'resubmitted')
        AND i.interviewer_id IS NOT NULL
      GROUP BY i.interviewer_id`.execute(this.xtx);
    const out = new Map<
      string,
      {
        userId: string;
        name: string;
        pending: number;
        flagged: number;
        kinds: Partial<Record<(typeof RISK_FLAGS)[number], number>>;
      }
    >();
    for (const r of flaggedRes.rows)
      out.set(low(r.user_id), {
        userId: low(r.user_id),
        name: '',
        pending: r.pending,
        flagged: r.flagged ?? 0,
        kinds: {},
      });
    for (const r of res.rows) {
      const o = out.get(low(r.user_id));
      if (!o) continue;
      o.name = r.name;
      if (r.flag) o.kinds[r.flag as (typeof RISK_FLAGS)[number]] = r.n;
    }
    return [...out.values()].sort((a, b) => b.flagged - a.flagged || a.name.localeCompare(b.name));
  }

  async expiringWithin(projectId: string, hours: number, within: number) {
    // Due from now to `within` hours ahead, among the cases the expiry job would close
    // (`expireDue`): held by someone and not checked out to a device.
    const now = Date.now();
    const from = new Date(now - hours * 3_600_000);
    const until = new Date(now + (within - hours) * 3_600_000);
    const r = await this.xtx
      .selectFrom('cases')
      .select(ksql<number>`COUNT(*)`.as('n'))
      .where('project_id', '=', projectId)
      .where('status', 'in', ['assigned', 'in_progress'])
      .where('assigned_to', 'is not', null)
      .where('checked_out_device', 'is', null)
      .where('assigned_at', '>', instant(from))
      .where('assigned_at', '<=', instant(until))
      .executeTakeFirstOrThrow();
    return r.n;
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
