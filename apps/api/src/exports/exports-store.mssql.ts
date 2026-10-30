import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';
import type { MssqlSchema } from '../db/mssql/schema.js';
import { claimJob } from '../jobs/claim.mssql.js';
import { COUNTED } from '../review/review-store.mssql.js';
import { dayStart, nextDay } from '../stats/zoned-day.js';

/**
 * Exports on SQL Server (Kysely): the jobs the worker builds, the pages of interviews an export
 * reads, and the read-only summary links, as `exports.service.ts`, `dataset.service.ts` and
 * `share.service.ts` do them on PostgreSQL with Drizzle (docs/roadmap.md). Takes the transaction of
 * `MssqlDatabase.withTenant`. The files themselves go to export storage, not to the database.
 */
export type ExportRow = Omit<Selectable<MssqlSchema['exports']>, 'options' | 'file'> & {
  options: Record<string, unknown>;
};

export const EXPORT_MAX_ATTEMPTS = 3;
export const EXPORT_STUCK_MS = 15 * 60_000;

const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));

/** What a page of interviews is read with. */
export interface DataFilter {
  projectId: string;
  questionnaireId: string;
  /** The project's IANA time zone, for the local days of `from` and `to`. */
  timezone: string;
  /** Only approved interviews, instead of all that count as data. */
  approvedOnly?: boolean;
  completesOnly?: boolean;
  mode?: string;
  interviewerId?: string;
  /** Local days, YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
  paradata?: boolean;
}

/** Where the next page starts: the submission time of the last row and its id. */
export interface PageKey {
  at: string;
  id: string;
}

export class ExportsStore {
  async create(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      questionnaireId: string;
      requestedBy: string;
      options: Record<string, unknown>;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('exports')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        questionnaire_id: v.questionnaireId,
        requested_by: v.requestedBy,
        options: JSON.stringify(v.options),
        file_name: null,
        content_type: null,
        file: null,
        storage_key: null,
        size: null,
        rows: null,
        error: null,
        finished_at: null,
        started_at: null,
      })
      .execute();
    return id;
  }

  async get(tx: MssqlTx, id: string): Promise<ExportRow | undefined> {
    const r = await tx
      .selectFrom('exports')
      .select([
        'id',
        'tenant_id',
        'project_id',
        'questionnaire_id',
        'requested_by',
        'options',
        'status',
        'file_name',
        'content_type',
        'storage_key',
        'size',
        'rows',
        'error',
        'created_at',
        'finished_at',
        'started_at',
        'attempts',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    return r && { ...r, options: parse(r.options) };
  }

  /** Takes the export to build, once (a queued one, or one whose worker was lost). */
  async claim(tx: MssqlTx, id: string, now = new Date()): Promise<ExportRow | null> {
    const ok = await claimJob(tx, 'exports', id, {
      maxAttempts: EXPORT_MAX_ATTEMPTS,
      stuckMs: EXPORT_STUCK_MS,
      now,
    });
    return ok ? ((await this.get(tx, id)) ?? null) : null;
  }

  async done(
    tx: MssqlTx,
    id: string,
    v: { fileName: string; contentType: string; storageKey: string; size: number; rows: number },
  ): Promise<void> {
    await tx
      .updateTable('exports')
      .set({
        status: 'done',
        file_name: v.fileName,
        content_type: v.contentType,
        storage_key: v.storageKey,
        size: v.size,
        rows: v.rows,
        error: null,
        finished_at: sql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', id)
      .execute();
  }

  /** The attempt failed: queued again for another try, or failed for good. */
  async failed(tx: MssqlTx, id: string, error: string, final: boolean): Promise<void> {
    await tx
      .updateTable('exports')
      .set({
        status: final ? 'failed' : 'queued',
        error,
        ...(final ? { finished_at: sql<Date>`SYSDATETIMEOFFSET()` } : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  async list(tx: MssqlTx, projectId: string, limit = 50) {
    return tx
      .selectFrom('exports')
      .select([
        'id',
        'questionnaire_id',
        'requested_by',
        'status',
        'file_name',
        'size',
        'rows',
        'error',
        'created_at',
        'finished_at',
      ])
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .top(limit)
      .execute();
  }

  /** Exports finished before `before`: removes their rows and returns the storage keys to delete. */
  async purge(tx: MssqlTx, v: { projectId: string; before: Date }): Promise<string[]> {
    const res = await sql<{ storage_key: string | null }>`
      DELETE FROM dbo.exports OUTPUT deleted.storage_key
      WHERE project_id = ${v.projectId} AND finished_at IS NOT NULL AND finished_at < ${v.before.toISOString()}`.execute(
      tx,
    );
    return res.rows.map((r) => r.storage_key).filter((k): k is string => !!k);
  }

  // Pages of interviews

  /**
   * One page of the interviews an export or a summary reads, in submission order after `after`
   * (null: the first). Each page is its own short read on the (project, submitted_at, id) index, so
   * an export of any size never holds a connection or the whole data: ask again with the returned
   * `after` until it is null.
   */
  async page(tx: MssqlTx, f: DataFilter, after: PageKey | null, size: number) {
    const dayFrom = f.from ? dayStart(f.from, f.timezone).toISOString() : null;
    const dayTo = f.to ? dayStart(nextDay(f.to), f.timezone).toISOString() : null;
    const statuses = f.approvedOnly ? ['approved'] : [...COUNTED];
    const res = await sql<{
      id: string;
      case_id: string | null;
      case_code: string | null;
      mode: string;
      status: string;
      disposition: string | null;
      interviewer: string | null;
      started_at: Date;
      submitted_at: Date;
      active_ms: number;
      version: number;
      language: string;
      answers: string;
      flags: string;
      role: string | null;
      stratum: string | null;
      prob: number | null;
      weight: number | null;
      back: number | null;
      notes: number | null;
      pauses: number | null;
      warnings: number | null;
      page_at: string;
    }>`
      SELECT TOP (${size}) i.id, i.case_id, c.external_id AS case_code, i.mode, i.status,
        i.disposition, u.name AS interviewer, i.started_at, i.submitted_at, i.active_ms,
        v.version, i.language, i.answers, i.flags,
        c.selection_role AS role, fu.stratum, c.inclusion_prob AS prob, c.base_weight AS weight,
        ${f.paradata ? sql`pd.back, pd.notes, pd.pauses, pd.warnings` : sql`NULL AS back, NULL AS notes, NULL AS pauses, NULL AS warnings`},
        CONVERT(varchar(33), i.submitted_at, 127) AS page_at
      FROM dbo.interviews i
      JOIN dbo.questionnaire_versions v ON v.id = i.questionnaire_version_id
      LEFT JOIN dbo.users u ON u.id = i.interviewer_id
      LEFT JOIN dbo.cases c ON c.id = i.case_id
      LEFT JOIN dbo.frame_units fu ON fu.id = c.frame_unit_id
      ${
        f.paradata
          ? sql`OUTER APPLY (
              SELECT SUM(CASE WHEN type = 'navigate_back' THEN 1 ELSE 0 END) AS back,
                     SUM(CASE WHEN type = 'note_added' THEN 1 ELSE 0 END) AS notes,
                     SUM(CASE WHEN type = 'pause' THEN 1 ELSE 0 END) AS pauses,
                     SUM(CASE WHEN type = 'warning_confirmed' THEN 1 ELSE 0 END) AS warnings
              FROM dbo.interview_paradata p WHERE p.interview_id = i.id) pd`
          : sql``
      }
      WHERE i.project_id = ${f.projectId} AND v.questionnaire_id = ${f.questionnaireId}
        AND i.entry_pass = 1 AND i.status IN (${sql.join(statuses)}) AND i.submitted_at IS NOT NULL
        ${f.completesOnly ? sql`AND i.disposition = 'COMPLETE'` : sql``}
        ${f.mode ? sql`AND i.mode = ${f.mode}` : sql``}
        ${f.interviewerId ? sql`AND i.interviewer_id = ${f.interviewerId}` : sql``}
        ${dayFrom ? sql`AND i.submitted_at >= ${dayFrom}` : sql``}
        ${dayTo ? sql`AND i.submitted_at < ${dayTo}` : sql``}
        ${after ? sql`AND (i.submitted_at > ${after.at} OR (i.submitted_at = ${after.at} AND i.id > ${after.id}))` : sql``}
      ORDER BY i.submitted_at, i.id`.execute(tx);
    const rows = res.rows;
    const last = rows.at(-1);
    return {
      after: last && rows.length === size ? { at: last.page_at, id: last.id.toLowerCase() } : null,
      interviews: rows.map(
        ({ page_at: _at, role, stratum, prob, weight, back, notes, pauses, warnings, ...r }) => ({
          ...r,
          id: r.id.toLowerCase(),
          answers: parse<Record<string, unknown>>(r.answers),
          flags: parse<Record<string, unknown>>(r.flags),
          sampling: { role, stratum, prob, weight },
          paradata: f.paradata
            ? {
                backMoves: back ?? 0,
                notes: notes ?? 0,
                pauses: pauses ?? 0,
                warnings: warnings ?? 0,
              }
            : undefined,
        }),
      ),
    };
  }

  // Summary links for clients

  async createShare(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      tokenHash: string;
      tokenEnc: string;
      createdBy: string;
      expiresAt?: Date | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('share_links')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        token_hash: v.tokenHash,
        token_enc: v.tokenEnc,
        created_by: v.createdBy,
        expires_at: v.expiresAt ?? null,
        revoked_at: null,
      })
      .execute();
    return id;
  }

  async shares(tx: MssqlTx, projectId: string) {
    return tx
      .selectFrom('share_links')
      .select(['id', 'created_by', 'created_at', 'expires_at', 'revoked_at'])
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  async revokeShare(tx: MssqlTx, projectId: string, id: string): Promise<boolean> {
    const r = await tx
      .updateTable('share_links')
      .set({ revoked_at: sql<Date>`SYSDATETIMEOFFSET()` })
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  async share(tx: MssqlTx, id: string) {
    return tx.selectFrom('share_links').selectAll().where('id', '=', id).executeTakeFirst();
  }
}
