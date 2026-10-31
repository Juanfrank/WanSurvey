import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { sql as ksql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AnalysisTx } from '../analysis/analysis-repo.js';
import { MssqlAnalysisTx, PgAnalysisTx } from '../analysis/analysis-repo.js';
import { AuditService } from '../audit/audit.service.js';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { Database, type Tx } from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import { exports } from '../db/schema.js';
import { claimable, MAX_JOB_ATTEMPTS, STUCK_AFTER_MS } from '../jobs/claims.js';

/**
 * The database side of data exports, whichever engine runs (the pattern of
 * `auth/auth-repo.ts`). A transaction here is also an `AnalysisTx`, which reads the data.
 */
export type ExportRowView = typeof exports.$inferSelect;

export interface ExportsTx extends AnalysisTx {
  createExport(v: {
    projectId: string;
    questionnaireId: string;
    requestedBy: string;
    options: Record<string, unknown>;
  }): Promise<{ id: string; status: string; createdAt: Date }>;
  listExports(projectId: string): Promise<
    {
      id: string;
      options: unknown;
      status: string;
      fileName: string | null;
      size: number | null;
      rows: number | null;
      error: string | null;
      createdAt: Date;
      finishedAt: Date | null;
      requestedBy: string;
    }[]
  >;
  exportFile(
    projectId: string,
    id: string,
  ): Promise<{
    fileName: string | null;
    contentType: string | null;
    file: Buffer | null;
    storageKey: string | null;
    status: string;
    options: unknown;
  } | null>;
  exportRow(id: string): Promise<ExportRowView | null>;
  /** Takes a queued export (or one whose worker was lost) once; null when it is not takeable. */
  claimExport(id: string): Promise<ExportRowView | null>;
  finishExport(
    id: string,
    v: { fileName: string; contentType: string; storageKey: string; size: number; rows: number },
  ): Promise<void>;
  /** Back to the queue (the database was busy). */
  requeueExport(id: string): Promise<void>;
  failExport(id: string, error: string): Promise<void>;
  /** Marks the finished exports older than `before` as expired and returns their stored files. */
  expireExports(before: Date): Promise<{ id: string; key: string | null }[]>;
}

export interface ExportsRepo {
  inTenant<T>(tenantId: string, fn: (t: ExportsTx) => Promise<T>): Promise<T>;
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

export class PgExportsTx extends PgAnalysisTx implements ExportsTx {
  constructor(
    private readonly etx: Tx,
    private readonly et: string,
    audits: AuditService,
  ) {
    super(etx, et, audits);
  }

  async createExport(v: Parameters<ExportsTx['createExport']>[0]) {
    const [row] = await this.etx
      .insert(exports)
      .values({ tenantId: this.et, ...v })
      .returning({ id: exports.id, status: exports.status, createdAt: exports.createdAt });
    return row!;
  }

  listExports(projectId: string) {
    return this.etx
      .select({
        id: exports.id,
        options: exports.options,
        status: exports.status,
        fileName: exports.fileName,
        size: exports.size,
        rows: exports.rows,
        error: exports.error,
        createdAt: exports.createdAt,
        finishedAt: exports.finishedAt,
        requestedBy: exports.requestedBy,
      })
      .from(exports)
      .where(eq(exports.projectId, projectId))
      .orderBy(desc(exports.createdAt))
      .limit(100);
  }

  async exportFile(projectId: string, id: string) {
    const [row] = await this.etx
      .select({
        fileName: exports.fileName,
        contentType: exports.contentType,
        file: exports.file,
        storageKey: exports.storageKey,
        status: exports.status,
        options: exports.options,
      })
      .from(exports)
      .where(and(eq(exports.id, id), eq(exports.projectId, projectId)));
    return row ?? null;
  }

  async exportRow(id: string) {
    const [row] = await this.etx.select().from(exports).where(eq(exports.id, id));
    return row ?? null;
  }

  async claimExport(id: string) {
    const [claimed] = await this.etx
      .update(exports)
      .set({ status: 'running', startedAt: new Date(), attempts: sql`${exports.attempts} + 1` })
      .where(and(eq(exports.id, id), claimable(exports)))
      .returning();
    return claimed ?? null;
  }

  async finishExport(id: string, v: Parameters<ExportsTx['finishExport']>[1]) {
    await this.etx
      .update(exports)
      .set({
        status: 'done',
        fileName: v.fileName,
        contentType: v.contentType,
        storageKey: v.storageKey,
        size: v.size,
        rows: v.rows,
        finishedAt: new Date(),
      })
      .where(eq(exports.id, id));
  }

  async requeueExport(id: string) {
    await this.etx.update(exports).set({ status: 'queued' }).where(eq(exports.id, id));
  }

  async failExport(id: string, error: string) {
    await this.etx
      .update(exports)
      .set({ status: 'failed', error: error.slice(0, 500), finishedAt: new Date() })
      .where(eq(exports.id, id));
  }

  async expireExports(before: Date) {
    const old = await this.etx
      .select({ id: exports.id, key: exports.storageKey })
      .from(exports)
      .where(and(eq(exports.status, 'done'), lt(exports.finishedAt, before)))
      .for('update');
    if (old.length)
      await this.etx
        .update(exports)
        .set({ status: 'expired', file: null, storageKey: null })
        .where(
          inArray(
            exports.id,
            old.map((r) => r.id),
          ),
        );
    return old;
  }
}

@Injectable()
export class PgExportsRepo implements ExportsRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  inTenant<T>(tenantId: string, fn: (t: ExportsTx) => Promise<T>) {
    return this.database.withTenant(tenantId, (tx) =>
      fn(new PgExportsTx(tx, tenantId, this.audits)),
    );
  }
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));

function toExport(r: Record<string, unknown>): ExportRowView {
  const g = (k: string) => r[k] as never;
  return {
    id: low(r.id as string),
    tenantId: low(r.tenant_id as string),
    projectId: low(r.project_id as string),
    questionnaireId: low(r.questionnaire_id as string),
    requestedBy: low(r.requested_by as string),
    options: parse(r.options as string),
    status: g('status'),
    fileName: g('file_name'),
    contentType: g('content_type'),
    file: g('file'),
    storageKey: g('storage_key'),
    size: g('size'),
    rows: g('rows'),
    error: g('error'),
    createdAt: g('created_at'),
    finishedAt: g('finished_at'),
    startedAt: g('started_at'),
    attempts: g('attempts'),
  } as unknown as ExportRowView;
}

export class MssqlExportsTx extends MssqlAnalysisTx implements ExportsTx {
  constructor(
    private readonly metx: MssqlTx,
    private readonly met: string,
    cstore: CasesStore,
  ) {
    super(metx, met, cstore);
  }

  async createExport(v: Parameters<ExportsTx['createExport']>[0]) {
    const id = randomUUID();
    await this.metx
      .insertInto('exports')
      .values({
        id,
        tenant_id: this.met,
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
    const r = await this.metx
      .selectFrom('exports')
      .select(['id', 'status', 'created_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { id: low(r.id), status: r.status, createdAt: r.created_at as Date };
  }

  async listExports(projectId: string) {
    const rows = await this.metx
      .selectFrom('exports')
      .select([
        'id',
        'options',
        'status',
        'file_name',
        'size',
        'rows',
        'error',
        'created_at',
        'finished_at',
        'requested_by',
      ])
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .top(100)
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      options: parse(r.options),
      status: r.status,
      fileName: r.file_name,
      size: r.size,
      rows: r.rows,
      error: r.error,
      createdAt: r.created_at as Date,
      finishedAt: r.finished_at as Date | null,
      requestedBy: low(r.requested_by),
    }));
  }

  async exportFile(projectId: string, id: string) {
    const r = await this.metx
      .selectFrom('exports')
      .select(['file_name', 'content_type', 'file', 'storage_key', 'status', 'options'])
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return r
      ? {
          fileName: r.file_name,
          contentType: r.content_type,
          file: r.file,
          storageKey: r.storage_key,
          status: r.status,
          options: parse(r.options),
        }
      : null;
  }

  async exportRow(id: string) {
    const r = await this.metx
      .selectFrom('exports')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? toExport(r as never) : null;
  }

  async claimExport(id: string) {
    const stuck = new Date(Date.now() - STUCK_AFTER_MS);
    const res = await ksql<Record<string, unknown>>`
      UPDATE dbo.exports SET status = 'running', started_at = SYSDATETIMEOFFSET(),
        attempts = attempts + 1
      OUTPUT inserted.*
      WHERE id = ${id} AND attempts < ${MAX_JOB_ATTEMPTS}
        AND (status = 'queued' OR (status = 'running' AND started_at < ${instant(stuck)}))`.execute(
      this.metx,
    );
    return res.rows[0] ? toExport(res.rows[0]) : null;
  }

  async finishExport(id: string, v: Parameters<ExportsTx['finishExport']>[1]) {
    await this.metx
      .updateTable('exports')
      .set({
        status: 'done',
        file_name: v.fileName,
        content_type: v.contentType,
        storage_key: v.storageKey,
        size: v.size,
        rows: v.rows,
        finished_at: ksql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async requeueExport(id: string) {
    await this.metx.updateTable('exports').set({ status: 'queued' }).where('id', '=', id).execute();
  }

  async failExport(id: string, error: string) {
    await this.metx
      .updateTable('exports')
      .set({
        status: 'failed',
        error: error.slice(0, 500),
        finished_at: ksql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async expireExports(before: Date) {
    const res = await ksql<{ id: string; storage_key: string | null }>`
      UPDATE dbo.exports SET status = 'expired', [file] = NULL, storage_key = NULL
      OUTPUT inserted.id, deleted.storage_key
      WHERE status = 'done' AND finished_at < ${instant(before)}`.execute(this.metx);
    return res.rows.map((r) => ({ id: low(r.id), key: r.storage_key }));
  }
}

@Injectable()
export class MssqlExportsRepo implements ExportsRepo {
  private readonly cstore = new CasesStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: ExportsTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlExportsTx(tx, tenantId, this.cstore)),
    );
  }
}

export const EXPORTS_REPO = Symbol('EXPORTS_REPO');
