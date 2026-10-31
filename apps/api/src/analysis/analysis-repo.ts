import { Injectable } from '@nestjs/common';
import type { ExportInterview } from '@wansurvey/exporters';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
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
 * The reads behind toplines, crosstabs, exports and share links, whichever engine runs (the
 * pattern of `auth/auth-repo.ts`). A transaction here is also a `CasesTx`.
 */
export interface ReadFilter {
  questionnaireId?: string;
  mode?: string;
  from?: string;
  to?: string;
  interviewerId?: string;
  approvedOnly?: boolean;
}

export interface ReadSource {
  questionnaireId: string;
  versionId: string;
  name: string;
  compiled: CompiledQuestionnaire;
  tz: string;
}

export interface ReadPage {
  after: { at: string; id: string } | null;
  size: number;
}

export interface ShareRow {
  id: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  tokenEnc: string;
}

export interface AnalysisTx extends CasesTx {
  /** The project's questionnaires that have a published version, newest first. */
  questionnairesWithVersions(
    projectId: string,
  ): Promise<{ id: string; name: string; version: number }[]>;
  /** The latest version of a questionnaire, with the project's zone. */
  latestVersion(
    projectId: string,
    questionnaireId: string,
  ): Promise<{ id: string; name: string; compiled: CompiledQuestionnaire; tz: string } | null>;
  readInterviews(
    projectId: string,
    src: ReadSource,
    f: ReadFilter,
    opts: { paradata?: boolean; completesOnly?: boolean },
    page: ReadPage | null,
  ): Promise<{ interviews: ExportInterview[]; after: { at: string; id: string } | null }>;
  /** A cheap fingerprint of the project's interviews and published versions. */
  dataStamp(projectId: string): Promise<string>;
  projectBrief(
    projectId: string,
  ): Promise<{ name: string; code: string; settings: unknown } | null>;

  // Share links
  shareLinks(projectId: string): Promise<ShareRow[]>;
  createShareLink(v: {
    projectId: string;
    tokenHash: string;
    tokenEnc: string;
    createdBy: string;
    expiresAt: Date | null;
  }): Promise<string>;
  revokeShareLink(projectId: string, id: string): Promise<boolean>;
  shareLinkProject(id: string): Promise<string | null>;
}

export interface AnalysisRepo {
  inTenant<T>(tenantId: string, fn: (t: AnalysisTx) => Promise<T>): Promise<T>;
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

type Row = {
  id: string;
  caseId: string | null;
  caseCode: string | null;
  mode: string;
  status: string;
  disposition: string | null;
  interviewer: string | null;
  startedAt: Date;
  submittedAt: Date | null;
  activeMs: number;
  version: number;
  language: string;
  answers: Record<string, unknown>;
  flags: Record<string, unknown>;
  back: number | null;
  notes: number | null;
  pauses: number | null;
  warnings: number | null;
  role: string | null;
  stratum: string | null;
  prob: number | null;
  weight: number | null;
  pageAt: string;
};

function shape(
  rows: Row[],
  paradata: boolean | undefined,
  page: ReadPage | null,
): { interviews: ExportInterview[]; after: { at: string; id: string } | null } {
  const last = rows.at(-1);
  return {
    after: page && last && rows.length === page.size ? { at: last.pageAt, id: last.id } : null,
    interviews: rows.map(({ role, stratum, prob, weight, pageAt: _at, ...r }) => ({
      ...r,
      sampling: { role, stratum, prob, weight },
      paradata: paradata
        ? {
            backMoves: r.back ?? 0,
            notes: r.notes ?? 0,
            pauses: r.pauses ?? 0,
            warnings: r.warnings ?? 0,
          }
        : undefined,
    })) as ExportInterview[],
  };
}

const low = (s: string) => s.toLowerCase();
const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));

export class MssqlAnalysisTx extends MssqlCasesTx implements AnalysisTx {
  constructor(
    private readonly xtx: MssqlTx,
    private readonly tn: string,
    cstore: CasesStore,
  ) {
    super(xtx, tn, cstore);
  }

  async questionnairesWithVersions(projectId: string) {
    const res = await ksql<{ id: string; name: string; version: number }>`
      SELECT q.id, q.name, MAX(v.version) AS version
      FROM dbo.questionnaires q JOIN dbo.questionnaire_versions v ON v.questionnaire_id = q.id
      WHERE q.project_id = ${projectId}
      GROUP BY q.id, q.name ORDER BY MAX(v.published_at) DESC`.execute(this.xtx);
    return res.rows.map((r) => ({ ...r, id: low(r.id) }));
  }

  async latestVersion(projectId: string, questionnaireId: string) {
    const r = await this.xtx
      .selectFrom('questionnaire_versions as v')
      .innerJoin('questionnaires as q', 'q.id', 'v.questionnaire_id')
      .innerJoin('projects as p', 'p.id', 'q.project_id')
      .select(['v.id', 'q.name', 'v.compiled', 'p.timezone as tz'])
      .where('q.id', '=', questionnaireId)
      .where('q.project_id', '=', projectId)
      .orderBy('v.version', 'desc')
      .top(1)
      .executeTakeFirst();
    return r
      ? {
          id: low(r.id),
          name: r.name,
          compiled: parse<CompiledQuestionnaire>(r.compiled),
          tz: r.tz,
        }
      : null;
  }

  async readInterviews(
    projectId: string,
    src: ReadSource,
    f: ReadFilter,
    opts: { paradata?: boolean; completesOnly?: boolean },
    page: ReadPage | null,
  ) {
    const statuses = ksql.join(
      (f.approvedOnly ? ['approved'] : [...COUNTED]).map((s) => ksql`${s}`),
    );
    const from = f.from ? dayStart(f.from, src.tz) : null;
    const to = f.to ? dayStart(nextDay(f.to), src.tz) : null;
    const paradataCols = opts.paradata
      ? ksql`, pd.back, pd.notes, pd.pauses, pd.warnings`
      : ksql`, NULL AS back, NULL AS notes, NULL AS pauses, NULL AS warnings`;
    const paradataJoin = opts.paradata
      ? ksql`OUTER APPLY (
          SELECT SUM(CASE WHEN type = 'navigate_back' THEN 1 ELSE 0 END) AS back,
                 SUM(CASE WHEN type = 'note_added' THEN 1 ELSE 0 END) AS notes,
                 SUM(CASE WHEN type = 'pause' THEN 1 ELSE 0 END) AS pauses,
                 SUM(CASE WHEN type = 'warning_confirmed' THEN 1 ELSE 0 END) AS warnings
          FROM dbo.interview_paradata pd WHERE pd.interview_id = i.id) pd`
      : ksql``;
    const res = await ksql<Record<string, unknown>>`
      SELECT ${page ? ksql`TOP (${page.size})` : ksql``}
             i.id, i.case_id, c.external_id AS case_code, i.mode, i.status, i.disposition,
             u.name AS interviewer, c.selection_role AS role, fu.stratum,
             c.inclusion_prob AS prob, c.base_weight AS weight, i.started_at, i.submitted_at,
             i.active_ms, v.version, i.language, i.answers, i.flags,
             CONVERT(varchar(40), i.submitted_at, 127) AS page_at
             ${paradataCols}
      FROM dbo.interviews i
      JOIN dbo.questionnaire_versions v ON v.id = i.questionnaire_version_id
      LEFT JOIN dbo.users u ON u.id = i.interviewer_id
      LEFT JOIN dbo.cases c ON c.id = i.case_id
      LEFT JOIN dbo.frame_units fu ON fu.id = c.frame_unit_id
      ${paradataJoin}
      WHERE i.project_id = ${projectId} AND v.questionnaire_id = ${src.questionnaireId}
        AND i.entry_pass = 1 AND i.status IN (${statuses})
        ${opts.completesOnly ? ksql`AND i.disposition = 'COMPLETE'` : ksql``}
        ${f.mode ? ksql`AND i.mode = ${f.mode}` : ksql``}
        ${f.interviewerId ? ksql`AND i.interviewer_id = ${f.interviewerId}` : ksql``}
        ${from ? ksql`AND i.submitted_at >= ${instant(from)}` : ksql``}
        ${to ? ksql`AND i.submitted_at < ${instant(to)}` : ksql``}
        AND i.submitted_at IS NOT NULL
        ${
          page?.after
            ? ksql`AND (i.submitted_at > CAST(${page.after.at} AS datetimeoffset(3))
                    OR (i.submitted_at = CAST(${page.after.at} AS datetimeoffset(3))
                        AND i.id > CAST(${page.after.id} AS uniqueidentifier)))`
            : ksql``
        }
      ORDER BY i.submitted_at, i.id`.execute(this.xtx);
    const rows = res.rows.map((r) => ({
      id: low(r.id as string),
      caseId: r.case_id ? low(r.case_id as string) : null,
      caseCode: r.case_code as string | null,
      mode: r.mode as string,
      status: r.status as string,
      disposition: r.disposition as string | null,
      interviewer: r.interviewer as string | null,
      startedAt: r.started_at as Date,
      submittedAt: r.submitted_at as Date | null,
      activeMs: r.active_ms as number,
      version: r.version as number,
      language: r.language as string,
      answers: parse<Record<string, unknown>>(r.answers as string),
      flags: parse<Record<string, unknown>>(r.flags as string),
      back: (r.back as number | null) ?? null,
      notes: (r.notes as number | null) ?? null,
      pauses: (r.pauses as number | null) ?? null,
      warnings: (r.warnings as number | null) ?? null,
      role: r.role as string | null,
      stratum: r.stratum as string | null,
      prob: r.prob as number | null,
      weight: r.weight as number | null,
      pageAt: r.page_at as string,
    }));
    return shape(rows, opts.paradata, page);
  }

  async dataStamp(projectId: string) {
    const a = await ksql<{ n: number; m: string | null }>`
      SELECT COUNT(*) AS n, CONVERT(varchar(40), MAX(updated_at), 127) AS m
      FROM dbo.interviews WHERE project_id = ${projectId}`.execute(this.xtx);
    const b = await ksql<{ m: string | null }>`
      SELECT CONVERT(varchar(40), MAX(v.published_at), 127) AS m
      FROM dbo.questionnaire_versions v JOIN dbo.questionnaires qq ON qq.id = v.questionnaire_id
      WHERE qq.project_id = ${projectId}`.execute(this.xtx);
    return `${a.rows[0]?.n ?? 0}:${a.rows[0]?.m ?? ''}|${b.rows[0]?.m ?? ''}`;
  }

  async projectBrief(projectId: string) {
    const p = await this.xtx
      .selectFrom('projects')
      .select(['name', 'code', 'settings'])
      .where('id', '=', projectId)
      .executeTakeFirst();
    return p ? { name: p.name, code: p.code, settings: parse(p.settings) } : null;
  }

  async shareLinks(projectId: string) {
    const rows = await this.xtx
      .selectFrom('share_links')
      .select(['id', 'created_at', 'expires_at', 'revoked_at', 'token_enc'])
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      createdAt: r.created_at as Date,
      expiresAt: r.expires_at as Date | null,
      revokedAt: r.revoked_at as Date | null,
      tokenEnc: r.token_enc,
    }));
  }

  async createShareLink(v: Parameters<AnalysisTx['createShareLink']>[0]) {
    const id = randomUUID();
    await this.xtx
      .insertInto('share_links')
      .values({
        id,
        tenant_id: this.tn,
        project_id: v.projectId,
        token_hash: v.tokenHash,
        token_enc: v.tokenEnc,
        created_by: v.createdBy,
        expires_at: v.expiresAt ? instant(v.expiresAt) : null,
        revoked_at: null,
      })
      .execute();
    return id;
  }

  async revokeShareLink(projectId: string, id: string) {
    const r = await this.xtx
      .updateTable('share_links')
      .set({ revoked_at: ksql<Date>`SYSDATETIMEOFFSET()` })
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  async shareLinkProject(id: string) {
    const r = await this.xtx
      .selectFrom('share_links')
      .select('project_id')
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? low(r.project_id) : null;
  }
}

@Injectable()
export class MssqlAnalysisRepo implements AnalysisRepo {
  private readonly cstore = new CasesStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: AnalysisTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlAnalysisTx(tx, tenantId, this.cstore)),
    );
  }
}

export const ANALYSIS_REPO = Symbol('ANALYSIS_REPO');
