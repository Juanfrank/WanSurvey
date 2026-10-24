import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Readable, Writable } from 'node:stream';
import {
  codebook,
  csvEncoder,
  dtaEncoder,
  savEncoder,
  StatsCollector,
  TableBuilder,
  ZipStream,
  type Cell,
  type ExportInterview,
  type TableEncoder,
  type TableLayout,
  type TableStats,
} from '@wansurvey/exporters';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { can, type AuthContext } from '../common/auth-context.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Database, isTransient, type Tx } from '../db/database.js';
import { claimable, MAX_JOB_ATTEMPTS } from '../jobs/claims.js';
import { exports } from '../db/schema.js';
import { BUS, projectChannel, type Bus } from '../jobs/bus.js';
import { JobsService } from '../jobs/jobs.service.js';
import {
  DataFilter,
  DatasetService,
  type DataSource,
  type PageKey,
} from '../analysis/dataset.service.js';
import { EXPORT_STORAGE, type ExportStorage, type StorageWriter } from './storage.js';
import { sqlExport } from './sql-export.js';

export const EXPORT_FORMATS = ['csv', 'xlsx', 'sav', 'dta', 'codebook', 'sql'] as const;

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

/** Interviews read at a time: the most an export holds in memory. */
const PAGE = 500;

/** A file past EXPORT_MAX_BYTES: the export stops and fails, nothing is kept. */
class TooLarge extends Error {}

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  sav: 'application/x-spss-sav',
  dta: 'application/x-stata-dta',
  zip: 'application/zip',
  sql: 'application/sql; charset=utf-8',
} as const;

const safeName = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'data';

/** The codebook sheets of a table, into a streaming workbook. */
function addCodebookSheets(
  wb: ExcelJS.stream.xlsx.WorkbookWriter,
  columns: TableLayout['columns'],
) {
  const entries = codebook({ name: '', columns, rows: [] });
  const vars = wb.addWorksheet('variables');
  vars.columns = [16, 60, 16, 16].map((width) => ({ width }));
  const head = (ws: ExcelJS.Worksheet, names: string[]) => {
    const r = ws.addRow(names);
    r.font = { bold: true };
    r.commit();
  };
  head(vars, ['name', 'label', 'type', 'measure']);
  for (const e of entries) vars.addRow([e.name, e.label, e.type, e.measure]).commit();
  vars.commit();
  const values = wb.addWorksheet('values');
  values.columns = [14, 14, 40, 14].map((width) => ({ width }));
  head(values, ['name', 'code', 'label', 'missing']);
  for (const e of entries)
    for (const v of e.values)
      values.addRow([e.name, v.code, v.label, v.missing ? 'yes' : '']).commit();
  values.commit();
}

const isPersonal = (options: unknown) => (options as { personal?: boolean }).personal === true;

/**
 * Data exports (M6): requested here, built by the worker (`exports.build`), stored with the
 * request and downloaded once ready. Every request is audited.
 */
@Injectable()
export class ExportsService implements OnModuleInit {
  private readonly logger = new Logger('Exports');
  /** Interviews read at a time (tests make it small to cross pages). */
  pageSize = PAGE;

  constructor(
    private readonly database: Database,
    private readonly datasets: DatasetService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    @Inject(BUS) private readonly bus: Bus,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(EXPORT_STORAGE) private readonly storage: ExportStorage,
  ) {}

  onModuleInit() {
    this.jobs.register('exports.build', (d) =>
      this.build(d.tenantId as string, d.exportId as string),
    );
    this.jobs.register('exports.retention', () => this.expireOld());
    if (this.config.EXPORT_RETENTION_DAYS)
      this.jobs.schedule('exports.retention', { cron: '10 3 * * *' });
  }

  /**
   * Files of exports older than EXPORT_RETENTION_DAYS are deleted (the request stays, as
   * expired): they hold personal data and fill the database and its backups. Returns how many.
   */
  async expireOld(now = new Date()): Promise<number> {
    const days = this.config.EXPORT_RETENTION_DAYS;
    if (!days) return 0;
    const before = new Date(now.getTime() - days * 86_400_000);
    let n = 0;
    for (const tenantId of await this.database.allTenantIds()) {
      const rows = await this.database.withTenant(tenantId, async (tx) => {
        const old = await tx
          .select({ id: exports.id, key: exports.storageKey })
          .from(exports)
          .where(and(eq(exports.status, 'done'), lt(exports.finishedAt, before)))
          .for('update');
        if (old.length)
          await tx
            .update(exports)
            .set({ status: 'expired', file: null, storageKey: null })
            .where(
              inArray(
                exports.id,
                old.map((r) => r.id),
              ),
            );
        return old;
      });
      n += rows.length;
      for (const r of rows) if (r.key) await this.forget(r.key);
    }
    if (n) this.logger.log(`Deleted the files of ${n} old exports`);
    return n;
  }

  /** Deletes a stored file; a failure is logged (the storage's own expiry is the backstop). */
  private async forget(key: string) {
    await this.storage
      .remove(key)
      .catch((e: Error) => this.logger.warn(`Export file ${key} not deleted: ${e.message}`));
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
        // Answers marked personal go only to people allowed to see personal data.
        options: {
          ...body,
          questionnaireId: qid,
          personal: can(ctx.memberships, 'pii.view', projectId),
        },
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
    return row!;
  }

  /** Builds the export in the background; call it after the request's transaction commits. */
  queue(tenantId: string, exportId: string) {
    // Not queued now (Redis away): the sweeper takes it.
    return this.jobs.offer('exports.build', { tenantId, exportId });
  }

  /** Exports holding personal answers are marked, so the list can say who may download them. */
  async list(tx: Tx, projectId: string) {
    const rows = await tx
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
    return rows.map((r) => ({ ...r, personal: isPersonal(r.options) }));
  }

  async file(tx: Tx, ctx: AuthContext, projectId: string, id: string) {
    const [row] = await tx
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
    if (!row || row.status !== 'done' || (!row.file && !row.storageKey))
      throw new NotFoundException({ code: 'NOT_READY', message: 'This export is not ready' });
    // A file with personal answers goes only to people allowed to see personal data.
    if (isPersonal(row.options) && !can(ctx.memberships, 'pii.view', projectId))
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You may not see personal data' });
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
    const { fileName, contentType, file, storageKey } = row as typeof row & {
      fileName: string;
      contentType: string;
    };
    return {
      fileName,
      contentType,
      /** The file's bytes as a stream, from storage (or the database, for older exports). */
      open: async () =>
        storageKey
          ? this.storage.open(storageKey)
          : { stream: Readable.from([file!]), size: file!.length },
    };
  }

  /** The interviews of an export, page by page, each page read in its own short transaction. */
  private async *pages(
    tenantId: string,
    projectId: string,
    src: DataSource,
    opts: ExportBody,
  ): AsyncGenerator<ExportInterview[]> {
    let after: PageKey | null = null;
    do {
      const page = await this.database.withTenant(tenantId, (tx) =>
        this.datasets.page(
          tx,
          projectId,
          src,
          opts,
          { paradata: opts.paradata },
          after,
          this.pageSize,
        ),
      );
      if (page.interviews.length) yield page.interviews;
      after = page.after;
    } while (after);
  }

  /**
   * The job: reads the data page by page and writes the file to storage as it goes, so any
   * size of export needs memory for one page (PAGE interviews) and the storage's buffers.
   * Tables whose columns or header depend on the data are read twice or three times: once for
   * the columns (coded texts, wide roster rows), once for SPSS/Stata stats, once to write.
   */
  async build(tenantId: string, exportId: string): Promise<void> {
    const job = await this.database.withTenant(tenantId, async (tx) => {
      const [row] = await tx.select().from(exports).where(eq(exports.id, exportId));
      // Not visible yet (its transaction still open): fail, and the queue tries again.
      if (!row) throw new Error(`Export ${exportId} not found yet`);
      // Taken once: a queued export, or one whose worker was lost (running for too long).
      const [claimed] = await tx
        .update(exports)
        .set({ status: 'running', startedAt: new Date(), attempts: sql`${exports.attempts} + 1` })
        .where(and(eq(exports.id, exportId), claimable(exports)))
        .returning();
      return claimed ?? null;
    });
    if (!job) return;
    let writer: StorageWriter | undefined;
    try {
      const opts = ExportBody.parse(job.options);
      const src = await this.database.withTenant(tenantId, (tx) =>
        this.datasets.source(tx, job.projectId, opts),
      );
      const builder = new TableBuilder(src.compiled, {
        rosters: opts.rosters,
        paradata: opts.paradata,
        personal: isPersonal(job.options),
        ...(opts.language ? { language: opts.language } : {}),
      });
      let interviews = 0;
      for await (const page of this.pages(tenantId, job.projectId, src, opts)) {
        for (const i of page) builder.observe(i);
        interviews += page.length;
      }
      const layout = builder.layout();
      const tables = [layout.main, ...layout.rosters];
      const rowsOf = (i: ExportInterview, t: number): Cell[][] =>
        t === 0 ? [builder.mainRow(i)] : builder.rosterRows(i, t - 1);
      // The rows of one table, batch by batch (a page of interviews each).
      const rows = async function* (this: ExportsService, t: number) {
        for await (const page of this.pages(tenantId, job.projectId, src, opts))
          yield page.flatMap((i) => rowsOf(i, t));
      }.bind(this);

      const file = this.fileOf(src.name, opts, tables);
      writer = this.storage.create(`${tenantId}/${exportId}/${file.fileName}`, file.contentType);
      const max = this.config.EXPORT_MAX_BYTES;
      const w = writer;
      const out = async (chunk: Uint8Array) => {
        if (!chunk.length) return;
        if (w.size + chunk.length > max) throw new TooLarge();
        await w.write(chunk);
      };

      if (opts.format === 'sql') {
        await out(
          new TextEncoder().encode(
            sqlExport({
              name: src.name,
              projectId: job.projectId,
              questionnaireId: src.questionnaireId,
              versionId: src.versionId,
              language: opts.language ?? src.compiled.questionnaire.defaultLanguage,
              opts,
              main: { ...layout.main, rows: [] },
              rosters: layout.rosters.map((t) => ({ ...t, rows: [] })),
            }),
          ),
        );
      } else if (opts.format === 'xlsx' || opts.format === 'codebook') {
        await this.workbook(out, opts, tables, rows);
      } else {
        // SPSS and Stata write sizes in the header: one pass for every table's stats.
        let stats: TableStats[] | undefined;
        if (opts.format !== 'csv') {
          const collectors = tables.map((t) => new StatsCollector(t.columns));
          for await (const page of this.pages(tenantId, job.projectId, src, opts))
            for (const i of page) collectors.forEach((c, t) => c.add(rowsOf(i, t)));
          stats = collectors.map((c) => c.result());
        }
        const encoderOf = (t: number): TableEncoder => {
          const columns = tables[t]!.columns;
          if (opts.format === 'csv')
            return csvEncoder(columns, { labels: opts.labels === 'labels' });
          const o = { label: src.name };
          return opts.format === 'sav'
            ? savEncoder(columns, stats![t]!, o)
            : dtaEncoder(columns, stats![t]!, o);
        };
        const zip = tables.length > 1 ? new ZipStream() : undefined;
        for (let t = 0; t < tables.length; t++) {
          const enc = encoderOf(t);
          const put = zip ? (b: Uint8Array) => out(zip.data(b)) : out;
          if (zip) await out(zip.open(file.entries[t]!));
          await put(enc.head());
          for await (const batch of rows(t)) await put(enc.rows(batch));
          await put(enc.tail());
          if (zip) await out(zip.close());
        }
        if (zip) await out(zip.finish());
      }
      await writer.done();
      const size = writer.size;
      writer = undefined;
      await this.database.withTenant(tenantId, (tx) =>
        tx
          .update(exports)
          .set({
            status: 'done',
            fileName: file.fileName,
            contentType: file.contentType,
            storageKey: `${tenantId}/${exportId}/${file.fileName}`,
            size,
            rows: interviews,
            finishedAt: new Date(),
          })
          .where(eq(exports.id, exportId)),
      );
    } catch (e) {
      await writer?.abort().catch(() => undefined);
      const error =
        e instanceof TooLarge
          ? new Error(
              `The file is larger than ${Math.round(this.config.EXPORT_MAX_BYTES / 1e6)} MB; filter the data or split the export`,
            )
          : (e as Error);
      // The database busy or away: back to the queue, tried again (by the queue's retries or
      // the sweeper) a few times before giving up.
      if (isTransient(e) && job.attempts < MAX_JOB_ATTEMPTS) {
        this.logger.warn(`Export ${exportId} will be retried: ${error.message}`);
        await this.database
          .withTenant(tenantId, (tx) =>
            tx.update(exports).set({ status: 'queued' }).where(eq(exports.id, exportId)),
          )
          .catch(() => undefined);
        throw e;
      }
      this.logger.error(`Export ${exportId} failed: ${error.message}`);
      await this.database.withTenant(tenantId, (tx) =>
        tx
          .update(exports)
          .set({
            status: 'failed',
            error: error.message.slice(0, 500),
            finishedAt: new Date(),
          })
          .where(eq(exports.id, exportId)),
      );
    }
    await this.bus.publish(projectChannel(job.projectId), { type: 'export', id: exportId });
  }

  /** The file's name and type; with several tables (long rosters) a zip and its entries. */
  private fileOf(name: string, opts: ExportBody, tables: TableLayout[]) {
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `${safeName(name)}_${stamp}`;
    if (opts.format === 'sql')
      return { fileName: `${base}.sql`, contentType: CONTENT_TYPES.sql, entries: [] };
    if (opts.format === 'xlsx' || opts.format === 'codebook')
      return {
        fileName: `${base}${opts.format === 'codebook' ? '_codebook' : ''}.xlsx`,
        contentType: CONTENT_TYPES.xlsx,
        entries: [],
      };
    const ext = opts.format;
    if (tables.length === 1)
      return { fileName: `${base}.${ext}`, contentType: CONTENT_TYPES[ext], entries: [] };
    // Long rosters: one file per table, in a zip.
    return {
      fileName: `${base}.zip`,
      contentType: CONTENT_TYPES.zip,
      entries: tables.map((t, k) => (k === 0 ? `${base}.${ext}` : `${base}_${t.name}.${ext}`)),
    };
  }

  /**
   * Excel, written sheet by sheet as rows come (ExcelJS's streaming writer): the data sheets
   * (none for a codebook), then the codebook of the main table and of each roster table.
   */
  private async workbook(
    out: (chunk: Uint8Array) => Promise<void>,
    opts: ExportBody,
    tables: TableLayout[],
    rows: (t: number) => AsyncGenerator<Cell[][]>,
  ) {
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        out(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)).then(() => done(), done);
      },
    });
    const finished = new Promise<void>((ok, fail) => {
      sink.on('finish', ok);
      sink.on('error', fail);
    });
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: sink,
      useStyles: true,
      useSharedStrings: false,
    });
    wb.creator = 'WanSurvey';
    const labels = opts.labels === 'labels';
    if (opts.format === 'xlsx')
      for (let t = 0; t < tables.length; t++) {
        const table = tables[t]!;
        const ws = wb.addWorksheet((t === 0 ? 'data' : table.name).slice(0, 31), {
          views: [{ state: 'frozen', ySplit: 1 }],
        });
        const head = ws.addRow(table.columns.map((c) => c.name));
        head.font = { bold: true };
        head.commit();
        for await (const batch of rows(t))
          for (const row of batch)
            ws.addRow(
              row.map((v, i) => {
                const c = table.columns[i]!;
                if (labels && typeof v === 'number' && c.valueLabels?.has(v))
                  return c.valueLabels.get(v);
                return v;
              }),
            ).commit();
        ws.commit();
      }
    addCodebookSheets(wb, tables[0]!.columns);
    if (opts.format === 'codebook')
      for (const r of tables.slice(1)) {
        const ws = wb.addWorksheet(`variables_${r.name}`.slice(0, 31));
        const head = ws.addRow(['name', 'label', 'type']);
        head.font = { bold: true };
        head.commit();
        for (const e of codebook({ ...r, rows: [] })) ws.addRow([e.name, e.label, e.type]).commit();
        ws.commit();
      }
    await wb.commit();
    await finished;
  }
}
