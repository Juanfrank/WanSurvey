import { Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  buildTables,
  codebook,
  writeCsv,
  writeDta,
  writeSav,
  writeZip,
  type Table,
} from '@wansurvey/exporters';
import { and, desc, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { Database, type Tx } from '../db/database.js';
import { exports } from '../db/schema.js';
import { BUS, projectChannel, type Bus } from '../jobs/bus.js';
import { JobsService } from '../jobs/jobs.service.js';
import { DataFilter, DatasetService } from '../analysis/dataset.service.js';

export const EXPORT_FORMATS = ['csv', 'xlsx', 'sav', 'dta', 'codebook'] as const;

export const ExportBody = DataFilter.extend({
  format: z.enum(EXPORT_FORMATS),
  /** CSV and Excel: codes, or the labels of coded answers. */
  labels: z.enum(['codes', 'labels']).default('codes'),
  rosters: z.enum(['wide', 'long']).default('wide'),
  paradata: z.boolean().default(false),
  approvedOnly: z.boolean().default(false),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/)
    .optional(),
});
export type ExportBody = z.infer<typeof ExportBody>;

/** Large exports are refused rather than filling the database (M6). */
const MAX_BYTES = 100 * 1024 * 1024;

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  sav: 'application/x-spss-sav',
  dta: 'application/x-stata-dta',
  zip: 'application/zip',
} as const;

const safeName = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'data';

async function workbook(sheets: { name: string; table: Table }[], labels: boolean) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WanSurvey';
  for (const { name, table } of sheets) {
    const ws = wb.addWorksheet(name.slice(0, 31));
    ws.addRow(table.columns.map((c) => c.name)).font = { bold: true };
    for (const row of table.rows)
      ws.addRow(
        row.map((v, i) => {
          const c = table.columns[i]!;
          if (labels && typeof v === 'number' && c.valueLabels?.has(v)) return c.valueLabels.get(v);
          return v;
        }),
      );
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return wb;
}

function addCodebookSheets(wb: ExcelJS.Workbook, table: Table) {
  const entries = codebook(table);
  const vars = wb.addWorksheet('variables');
  vars.addRow(['name', 'label', 'type', 'measure']).font = { bold: true };
  for (const e of entries) vars.addRow([e.name, e.label, e.type, e.measure]);
  const values = wb.addWorksheet('values');
  values.addRow(['name', 'code', 'label', 'missing']).font = { bold: true };
  for (const e of entries)
    for (const v of e.values) values.addRow([e.name, v.code, v.label, v.missing ? 'yes' : '']);
  vars.columns.forEach((c, i) => (c.width = i === 1 ? 60 : 16));
  values.columns.forEach((c, i) => (c.width = i === 2 ? 40 : 14));
}

/**
 * Data exports (M6): requested here, built by the worker (`exports.build`), stored with the
 * request and downloaded once ready. Every request is audited.
 */
@Injectable()
export class ExportsService implements OnModuleInit {
  private readonly logger = new Logger('Exports');

  constructor(
    private readonly database: Database,
    private readonly datasets: DatasetService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    @Inject(BUS) private readonly bus: Bus,
  ) {}

  onModuleInit() {
    this.jobs.register('exports.build', (d) =>
      this.build(d.tenantId as string, d.exportId as string),
    );
  }

  async request(tx: Tx, ctx: AuthContext, projectId: string, body: ExportBody) {
    const qid = body.questionnaireId ?? (await this.datasets.questionnaires(tx, projectId))[0]?.id;
    if (!qid) throw new NotFoundException({ code: 'NO_DATA', message: 'Nothing published yet' });
    const [row] = await tx
      .insert(exports)
      .values({
        tenantId: ctx.tenantId,
        projectId,
        questionnaireId: qid,
        requestedBy: ctx.userId,
        options: { ...body, questionnaireId: qid },
      })
      .returning({ id: exports.id, status: exports.status, createdAt: exports.createdAt });
    await this.audit.record(
      tx,
      ctx.tenantId,
      this.audit.fromContext(ctx, {
        action: 'data.exported',
        targetType: 'export',
        targetId: row!.id,
        details: { projectId, ...body, questionnaireId: qid },
      }),
    );
    await this.jobs.enqueue('exports.build', { tenantId: ctx.tenantId, exportId: row!.id });
    return row!;
  }

  async list(tx: Tx, projectId: string) {
    return tx
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

  async file(tx: Tx, ctx: AuthContext, projectId: string, id: string) {
    const [row] = await tx
      .select({
        fileName: exports.fileName,
        contentType: exports.contentType,
        file: exports.file,
        status: exports.status,
      })
      .from(exports)
      .where(and(eq(exports.id, id), eq(exports.projectId, projectId)));
    if (!row || row.status !== 'done' || !row.file)
      throw new NotFoundException({ code: 'NOT_READY', message: 'This export is not ready' });
    await this.audit.record(
      tx,
      ctx.tenantId,
      this.audit.fromContext(ctx, {
        action: 'data.downloaded',
        targetType: 'export',
        targetId: id,
        details: { projectId, fileName: row.fileName },
      }),
    );
    return row as { fileName: string; contentType: string; file: Buffer };
  }

  /** The job: reads the data, writes the file, stores it. */
  async build(tenantId: string, exportId: string): Promise<void> {
    const job = await this.database.withTenant(tenantId, async (tx) => {
      const [row] = await tx.select().from(exports).where(eq(exports.id, exportId));
      if (!row || row.status === 'done') return null;
      await tx.update(exports).set({ status: 'running' }).where(eq(exports.id, exportId));
      return row;
    });
    if (!job) return;
    try {
      const opts = ExportBody.parse(job.options);
      const result = await this.database.withTenant(tenantId, async (tx) => {
        const data = await this.datasets.load(tx, job.projectId, opts, {
          paradata: opts.paradata,
        });
        const built = buildTables(data.compiled, data.interviews, {
          rosters: opts.rosters,
          paradata: opts.paradata,
          ...(opts.language ? { language: opts.language } : {}),
        });
        return { data, built, ...(await this.render(data.name, built, opts)) };
      });
      if (result.bytes.length > MAX_BYTES)
        throw new Error('The file is larger than 100 MB; filter the data or split the export');
      await this.database.withTenant(tenantId, (tx) =>
        tx
          .update(exports)
          .set({
            status: 'done',
            fileName: result.fileName,
            contentType: result.contentType,
            file: Buffer.from(result.bytes),
            size: result.bytes.length,
            rows: result.built.main.rows.length,
            finishedAt: new Date(),
          })
          .where(eq(exports.id, exportId)),
      );
    } catch (e) {
      this.logger.error(`Export ${exportId} failed: ${(e as Error).message}`);
      await this.database.withTenant(tenantId, (tx) =>
        tx
          .update(exports)
          .set({
            status: 'failed',
            error: (e as Error).message.slice(0, 500),
            finishedAt: new Date(),
          })
          .where(eq(exports.id, exportId)),
      );
    }
    await this.bus.publish(projectChannel(job.projectId), { type: 'export', id: exportId });
  }

  private async render(
    name: string,
    built: { main: Table; rosters: Table[] },
    opts: ExportBody,
  ): Promise<{ fileName: string; contentType: string; bytes: Uint8Array }> {
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `${safeName(name)}_${stamp}`;
    const labels = opts.labels === 'labels';
    if (opts.format === 'xlsx' || opts.format === 'codebook') {
      const wb =
        opts.format === 'xlsx'
          ? await workbook(
              [
                { name: 'data', table: built.main },
                ...built.rosters.map((t) => ({ name: t.name, table: t })),
              ],
              labels,
            )
          : new ExcelJS.Workbook();
      addCodebookSheets(wb, built.main);
      for (const r of opts.format === 'codebook' ? built.rosters : []) {
        const ws = wb.addWorksheet(`variables_${r.name}`.slice(0, 31));
        ws.addRow(['name', 'label', 'type']).font = { bold: true };
        for (const e of codebook(r)) ws.addRow([e.name, e.label, e.type]);
      }
      const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
      return {
        fileName: `${base}${opts.format === 'codebook' ? '_codebook' : ''}.xlsx`,
        contentType: CONTENT_TYPES.xlsx,
        bytes,
      };
    }
    const one = (t: Table): Uint8Array =>
      opts.format === 'csv'
        ? new TextEncoder().encode(writeCsv(t, { labels }))
        : opts.format === 'sav'
          ? writeSav(t, { label: name })
          : writeDta(t, { label: name });
    const ext = opts.format;
    if (!built.rosters.length)
      return {
        fileName: `${base}.${ext}`,
        contentType: CONTENT_TYPES[ext],
        bytes: one(built.main),
      };
    // Long rosters: one file per table, in a zip.
    const bytes = writeZip([
      { name: `${base}.${ext}`, data: one(built.main) },
      ...built.rosters.map((t) => ({ name: `${base}_${t.name}.${ext}`, data: one(t) })),
    ]);
    return { fileName: `${base}.zip`, contentType: CONTENT_TYPES.zip, bytes };
  }
}
