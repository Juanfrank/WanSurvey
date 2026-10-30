import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';
import type { MssqlSchema } from '../db/mssql/schema.js';
import { claimJob } from '../jobs/claim.mssql.js';

/**
 * Paper on SQL Server (Kysely): the differences between the two keyings of a form, and the scanned
 * PDFs with the forms found in them and the page images, as `papi.service.ts` and `scans.service.ts`
 * do them on PostgreSQL with Drizzle (docs/roadmap.md). Takes the transaction of
 * `MssqlDatabase.withTenant`. A batch is deleted with its pages and forms by the application: the
 * foreign keys do not cascade (see mssql/0008).
 */
export type BatchRow = Selectable<MssqlSchema['papi_scan_batches']>;

const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));

/** A batch is retried when its worker was lost; the same limits as the other background jobs. */
export const SCAN_MAX_ATTEMPTS = 3;
export const SCAN_STUCK_MS = 15 * 60_000;

export class PapiStore {
  // Double entry

  /** Records the variables whose two keyings differ; a second keying has each variable once. */
  async addMismatches(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      caseId: string;
      firstInterviewId: string;
      secondInterviewId: string;
      differences: { variable: string; firstValue: unknown; secondValue: unknown }[];
    },
  ): Promise<void> {
    if (!v.differences.length) return;
    const rows = v.differences.map((d) => ({
      id: randomUUID(),
      variable: d.variable,
      first:
        d.firstValue === undefined || d.firstValue === null ? null : JSON.stringify(d.firstValue),
      second:
        d.secondValue === undefined || d.secondValue === null
          ? null
          : JSON.stringify(d.secondValue),
    }));
    await sql`
      INSERT INTO dbo.entry_mismatches (id, tenant_id, project_id, case_id, first_interview_id,
        second_interview_id, variable, first_value, second_value)
      SELECT j.id, ${v.tenantId}, ${v.projectId}, ${v.caseId}, ${v.firstInterviewId},
        ${v.secondInterviewId}, j.variable, j.first, j.second
      FROM OPENJSON(${JSON.stringify(rows)}) WITH (
        id uniqueidentifier, variable nvarchar(450), [first] nvarchar(max), [second] nvarchar(max)
      ) j`.execute(tx);
  }

  async mismatches(tx: MssqlTx, projectId: string, status: 'open' | 'resolved' | 'all' = 'open') {
    const res = await sql<{
      id: string;
      case_id: string;
      external_id: string;
      variable: string;
      first_value: string | null;
      second_value: string | null;
      status: string;
      resolved_value: string | null;
      resolved_by: string | null;
      resolver: string | null;
      resolved_at: Date | null;
      first_interview_id: string;
    }>`
      SELECT m.id, m.case_id, c.external_id, m.variable, m.first_value, m.second_value, m.status,
        m.resolved_value, m.resolved_by, u.name AS resolver, m.resolved_at, m.first_interview_id
      FROM dbo.entry_mismatches m
      JOIN dbo.cases c ON c.id = m.case_id
      LEFT JOIN dbo.users u ON u.id = m.resolved_by
      WHERE m.project_id = ${projectId} ${status === 'all' ? sql`` : sql`AND m.status = ${status}`}
      ORDER BY c.external_id, m.variable`.execute(tx);
    return res.rows.map((r) => ({
      ...r,
      id: r.id.toLowerCase(),
      first_value: parse<unknown>(r.first_value),
      second_value: parse<unknown>(r.second_value),
      resolved_value: parse<unknown>(r.resolved_value),
    }));
  }

  /** Chooses the right value of a difference. Only an open one can be resolved, once. */
  async resolveMismatch(
    tx: MssqlTx,
    v: { projectId: string; id: string; value: unknown; userId: string },
  ): Promise<boolean> {
    const r = await tx
      .updateTable('entry_mismatches')
      .set({
        status: 'resolved',
        resolved_value: v.value === undefined || v.value === null ? null : JSON.stringify(v.value),
        resolved_by: v.userId,
        resolved_at: sql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', v.id)
      .where('project_id', '=', v.projectId)
      .where('status', '=', 'open')
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  async openMismatches(tx: MssqlTx, caseId: string): Promise<number> {
    const r = await tx
      .selectFrom('entry_mismatches')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('case_id', '=', caseId)
      .where('status', '=', 'open')
      .executeTakeFirstOrThrow();
    return r.n;
  }

  // Scanned batches

  async addBatch(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      uploadedBy: string | null;
      fileName: string;
      pdf: Buffer;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('papi_scan_batches')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        uploaded_by: v.uploadedBy,
        file_name: v.fileName,
        pdf: v.pdf,
        error: null,
        finished_at: null,
        started_at: null,
      })
      .execute();
    return id;
  }

  /** Takes the batch to read, once (see `claimJob`); returns it, with its PDF, or null. */
  async claimBatch(tx: MssqlTx, id: string, now = new Date()): Promise<BatchRow | null> {
    const ok = await claimJob(tx, 'papi_scan_batches', id, {
      maxAttempts: SCAN_MAX_ATTEMPTS,
      stuckMs: SCAN_STUCK_MS,
      now,
    });
    if (!ok) return null;
    return (
      (await tx
        .selectFrom('papi_scan_batches')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()) ?? null
    );
  }

  /** The PDF is dropped once it is read; the pages are kept as images. */
  async finishBatch(tx: MssqlTx, id: string, v: { pages: number }): Promise<void> {
    await tx
      .updateTable('papi_scan_batches')
      .set({
        status: 'done',
        pages: v.pages,
        pdf: null,
        finished_at: sql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async failBatch(tx: MssqlTx, id: string, error: string): Promise<void> {
    await tx
      .updateTable('papi_scan_batches')
      .set({ status: 'failed', error, finished_at: sql<Date>`SYSDATETIMEOFFSET()` })
      .where('id', '=', id)
      .execute();
  }

  async batches(tx: MssqlTx, projectId: string) {
    return tx
      .selectFrom('papi_scan_batches')
      .select([
        'id',
        'file_name',
        'status',
        'pages',
        'error',
        'created_at',
        'finished_at',
        'attempts',
      ])
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  /** Deletes a batch with its pages and forms (the foreign keys do not cascade). */
  async deleteBatch(tx: MssqlTx, id: string): Promise<void> {
    await tx.deleteFrom('papi_scan_pages').where('batch_id', '=', id).execute();
    await tx.deleteFrom('papi_scan_forms').where('batch_id', '=', id).execute();
    await tx.deleteFrom('papi_scan_batches').where('id', '=', id).execute();
  }

  // Forms and pages

  async addForm(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      batchId: string;
      caseId: string;
      questionnaireVersionId: string;
      lang: string;
      interviewId?: string | null;
      status: 'review' | 'done' | 'duplicate' | 'failed';
      pagesExpected: number;
      pagesFound: number[];
      issues?: { name: string; kind: string; detail?: string }[];
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('papi_scan_forms')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        batch_id: v.batchId,
        case_id: v.caseId,
        questionnaire_version_id: v.questionnaireVersionId,
        lang: v.lang,
        interview_id: v.interviewId ?? null,
        status: v.status,
        pages_expected: v.pagesExpected,
        pages_found: JSON.stringify(v.pagesFound),
        issues: JSON.stringify(v.issues ?? []),
      })
      .execute();
    return id;
  }

  async setFormStatus(
    tx: MssqlTx,
    id: string,
    v: { status: 'review' | 'done' | 'duplicate' | 'failed'; issues?: unknown[] },
  ): Promise<void> {
    await tx
      .updateTable('papi_scan_forms')
      .set({
        status: v.status,
        updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
        ...(v.issues ? { issues: JSON.stringify(v.issues) } : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  async forms(tx: MssqlTx, batchId: string) {
    const rows = await tx
      .selectFrom('papi_scan_forms')
      .selectAll()
      .where('batch_id', '=', batchId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({
      ...r,
      pages_found: parse<number[]>(r.pages_found),
      issues: parse<unknown[]>(r.issues),
    }));
  }

  async addPages(
    tx: MssqlTx,
    v: {
      tenantId: string;
      batchId: string;
      pages: {
        pageNo: number;
        formId?: string | null;
        formPage?: number | null;
        problem?: string | null;
        transform?: unknown;
        width: number;
        height: number;
        image: Buffer;
      }[];
    },
  ): Promise<void> {
    // Images are large: one statement each keeps a request small.
    for (const p of v.pages)
      await tx
        .insertInto('papi_scan_pages')
        .values({
          id: randomUUID(),
          tenant_id: v.tenantId,
          batch_id: v.batchId,
          form_id: p.formId ?? null,
          page_no: p.pageNo,
          form_page: p.formPage ?? null,
          problem: p.problem ?? null,
          transform:
            p.transform === undefined || p.transform === null ? null : JSON.stringify(p.transform),
          width: p.width,
          height: p.height,
          image: p.image,
        })
        .execute();
  }

  /** The pages of a batch without their images, in page order. */
  async pages(tx: MssqlTx, batchId: string) {
    const rows = await tx
      .selectFrom('papi_scan_pages')
      .select(['id', 'page_no', 'form_id', 'form_page', 'problem', 'transform', 'width', 'height'])
      .where('batch_id', '=', batchId)
      .orderBy('page_no')
      .execute();
    return rows.map((r) => ({ ...r, transform: parse<unknown>(r.transform) }));
  }

  async pageImage(tx: MssqlTx, id: string): Promise<Buffer | undefined> {
    const r = await tx
      .selectFrom('papi_scan_pages')
      .select('image')
      .where('id', '=', id)
      .executeTakeFirst();
    return r?.image;
  }
}
