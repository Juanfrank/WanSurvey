import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Readable } from 'node:stream';
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
  excelMomentFormat,
  isMoment,
  wallClock,
  type ReadableFormat,
} from '@wansurvey/exporters';
import { writeXlsxStreamSheets, type XlsxStreamRow, type XlsxStreamSheet } from 'hucre/xlsx';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { can, type AuthContext } from '../common/auth-context.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Engine } from '../db/engine.js';
import { MAX_JOB_ATTEMPTS } from '../jobs/claims.js';
import { BUS, projectChannel, type Bus } from '../jobs/bus.js';
import { JobsService } from '../jobs/jobs.service.js';
import {
  DataFilter,
  DatasetService,
  type DataSource,
  type PageKey,
} from '../analysis/dataset.service.js';
import { EXPORT_STORAGE, type ExportStorage, type StorageWriter } from './storage.js';
import { EXPORTS_REPO, type ExportsRepo, type ExportsTx } from './exports-repo.js';
import { sqlExport } from './sql-export.js';
import { isTransient } from '../db/common.js';
import { trimUnderscores } from '../common/text.js';

export const EXPORT_FORMATS = ['csv', 'xlsx', 'sav', 'dta', 'codebook', 'sql'] as const;

export const ExportBody = DataFilter.extend({
  format: z.enum(EXPORT_FORMATS),
  /** CSV and Excel: codes, or the labels of coded answers. */
  labels: z.enum(['codes', 'labels']).default('codes'),
  rosters: z.enum(['wide', 'long']).default('wide'),
  paradata: z.boolean().default(false),
  approvedOnly: z.boolean().default(false),
  /** CSV: the codebook (variables and coded values) alongside the data, all in a ZIP. */
  codebook: z.boolean().optional(),
  /**
   * Answers marked personal: left out unless asked for with `include`, which needs the
   * permission to see personal data (`pii.view`) in the project; without it the request is
   * refused (403 `PERSONAL_DATA_FORBIDDEN`), not quietly changed. Same for the codebook.
   */
  personalData: z
    .enum(['include', 'exclude'])
    .default('exclude')
    .describe(
      'Answers marked personal: left out by default. `include` needs the permission to see personal data (pii.view) in the project, otherwise 403 PERSONAL_DATA_FORBIDDEN.',
    ),
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
  trimUnderscores(
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '_'),
  ).slice(0, 60) || 'data';

const BOLD = { font: { bold: true } };
type SheetCell = string | number | boolean | null;

/** A header row in bold, then the rows. */
function* withHeader(names: string[], body: Iterable<SheetCell[]>): Generator<XlsxStreamRow> {
  yield names.map((value) => ({ value, style: BOLD }));
  yield* body;
}

/** The codebook sheets of a table: its variables, and the values of each. */
function codebookSheets(columns: TableLayout['columns']): XlsxStreamSheet[] {
  const entries = codebook({ name: '', columns, rows: [] });
  return [
    {
      name: 'variables',
      columns: [16, 60, 16, 16].map((width) => ({ width })),
      rows: withHeader(
        ['name', 'label', 'type', 'measure'],
        entries.map((e) => [e.name, e.label, e.type, e.measure ?? null]),
      ),
    },
    {
      name: 'values',
      columns: [14, 14, 40, 14].map((width) => ({ width })),
      rows: withHeader(
        ['name', 'code', 'label', 'missing'],
        entries.flatMap((e) =>
          e.values.map((v): SheetCell[] => [e.name, v.code, v.label, v.missing ? 'yes' : '']),
        ),
      ),
    },
  ];
}

/**
 * The rows of a data table as they come in batches, value labels in place of codes if asked.
 * With the organisation's regional format, moments are Excel dates in the project's time zone,
 * shown the locale's way (numbers stay numbers, which Excel shows as its user's settings say).
 */
async function* dataRows(
  table: TableLayout,
  batches: AsyncGenerator<Cell[][]>,
  labels: boolean,
  readable?: ReadableFormat,
): AsyncGenerator<XlsxStreamRow> {
  yield table.columns.map((c) => ({ value: c.name, style: BOLD }));
  const moments = readable ? table.columns.map(isMoment) : [];
  const toDate = readable ? wallClock(readable.timeZone) : null;
  const momentStyle = readable ? { numFmt: excelMomentFormat(readable.locale) } : undefined;
  for await (const batch of batches)
    for (const row of batch)
      yield row.map((v, i) => {
        const c = table.columns[i]!;
        if (labels && typeof v === 'number' && c.valueLabels?.has(v)) return c.valueLabels.get(v)!;
        if (moments[i] && typeof v === 'string') {
          const value = toDate!(v);
          if (value) return { value, style: momentStyle };
        }
        return v;
      }) as XlsxStreamRow;
}

/** A column of text, for the codebook written as CSV. */
const textColumn = (name: string): TableLayout['columns'][number] => ({
  name,
  label: name,
  type: 'string',
});

/**
 * The codebook as two CSV files, for a CSV export: the variables of every table, and the coded
 * values of each, both naming the table they belong to.
 */
export function codebookCsv(tables: TableLayout[]): { variables: Uint8Array; values: Uint8Array } {
  const entries = tables.flatMap((t) =>
    codebook({ ...t, rows: [] }).map((e) => ({ table: t.name, ...e })),
  );
  const file = (names: string[], rows: Cell[][]) => {
    const enc = csvEncoder(names.map(textColumn));
    const head = enc.head();
    const body = enc.rows(rows);
    const out = new Uint8Array(head.length + body.length);
    out.set(head);
    out.set(body, head.length);
    return out;
  };
  return {
    variables: file(
      ['table', 'name', 'label', 'type', 'measure'],
      entries.map((e) => [e.table, e.name, e.label, e.type, e.measure]),
    ),
    values: file(
      ['table', 'name', 'code', 'label', 'missing'],
      entries.flatMap((e) =>
        e.values.map((v): Cell[] => [e.table, e.name, v.code, v.label, v.missing ? 'yes' : '']),
      ),
    ),
  };
}

/** Only CSV takes the codebook in a zip: Excel, SPSS and Stata carry it in the file. */
const withCodebook = (opts: ExportBody) => opts.format === 'csv' && !!opts.codebook;

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
    @Inject(EXPORTS_REPO) private readonly repo: ExportsRepo,
    private readonly engine: Engine,
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
    for (const tenantId of await this.engine.allTenantIdsForRetention()) {
      const rows = await this.repo.inTenantForRetention(tenantId, (t) => t.expireExports(before));
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

  async request(t: ExportsTx, ctx: AuthContext, projectId: string, body: ExportBody) {
    // Personal answers only when asked for, and only for people allowed to see them: a request
    // for them without the permission is refused rather than answered with less than it says.
    const personal = body.personalData === 'include';
    if (personal && !can(ctx.memberships, 'pii.view', projectId))
      throw new ForbiddenException({
        code: 'PERSONAL_DATA_FORBIDDEN',
        message: 'Exporting personal data needs the permission to see personal data',
      });
    const qid = body.questionnaireId ?? (await this.datasets.questionnaires(t, projectId))[0]?.id;
    if (!qid) throw new NotFoundException({ code: 'NO_DATA', message: 'Nothing published yet' });
    const row = await t.createExport({
      projectId,
      questionnaireId: qid,
      requestedBy: ctx.userId,
      options: { ...body, questionnaireId: qid, personal },
    });
    await t.audit(
      this.audit.fromContext(ctx, {
        action: 'data.exported',
        targetType: 'export',
        targetId: row.id,
        details: { projectId, ...body, questionnaireId: qid },
      }),
    );
    return row;
  }

  /** Builds the export in the background; call it after the request's transaction commits. */
  queue(tenantId: string, exportId: string) {
    // Not queued now (Redis away): the sweeper takes it.
    return this.jobs.offer('exports.build', { tenantId, exportId });
  }

  /**
   * Exports holding personal answers are marked, so the list can say who may download them;
   * each says until when its file stays (EXPORT_RETENTION_DAYS after it was built) and who
   * downloaded it, from the audit log.
   */
  async list(t: ExportsTx, projectId: string) {
    const rows = await t.listExports(projectId);
    const downloads = await t.exportDownloads(rows.map((r) => r.id));
    const days = this.config.EXPORT_RETENTION_DAYS;
    return rows.map((r) => ({
      ...r,
      personal: isPersonal(r.options),
      availableUntil:
        r.status === 'done' && days && r.finishedAt
          ? new Date(new Date(r.finishedAt).getTime() + days * 86_400_000)
          : null,
      downloads: downloads.get(r.id) ?? { count: 0, last: null },
    }));
  }

  async file(t: ExportsTx, ctx: AuthContext, projectId: string, id: string) {
    const row = await t.exportFile(projectId, id);
    if (!row || row.status !== 'done' || (!row.file && !row.storageKey))
      throw new NotFoundException({ code: 'NOT_READY', message: 'This export is not ready' });
    // A file with personal answers goes only to people allowed to see personal data.
    if (isPersonal(row.options) && !can(ctx.memberships, 'pii.view', projectId))
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You may not see personal data' });
    await t.audit(
      this.audit.fromContext(ctx, {
        action: 'data.downloaded',
        targetType: 'export',
        targetId: id,
        details: { projectId, fileName: row.fileName },
      }),
    );
    const { file, storageKey } = row;
    const fileName = row.fileName!;
    const contentType = row.contentType!;
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
  private get sqlExportOf() {
    return sqlExport;
  }

  private async *pages(
    tenantId: string,
    projectId: string,
    src: DataSource,
    opts: ExportBody,
  ): AsyncGenerator<ExportInterview[]> {
    let after: PageKey | null = null;
    do {
      const page = await this.repo.inTenant(tenantId, (t) =>
        this.datasets.page(
          t,
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
    const job = await this.repo.inTenant(tenantId, async (t) => {
      // Not visible yet (its transaction still open): fail, and the queue tries again.
      if (!(await t.exportRow(exportId))) throw new Error(`Export ${exportId} not found yet`);
      // Taken once: a queued export, or one whose worker was lost (running for too long).
      return t.claimExport(exportId);
    });
    if (!job) return;
    let writer: StorageWriter | undefined;
    try {
      const opts = ExportBody.parse(job.options);
      const { src, locale } = await this.repo.inTenant(tenantId, async (t) => ({
        src: await this.datasets.source(t, job.projectId, opts),
        locale: await t.formatLocale(),
      }));
      // Readable files (CSV and Excel with labels) write moments and numbers the way the
      // organisation chose; the data formats and files with codes keep theirs.
      const readable: ReadableFormat | undefined =
        opts.labels === 'labels' && locale ? { locale, timeZone: src.tz } : undefined;
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
      // Moments written in the project's zone say so in their label (the codebook's too).
      const tables = [layout.main, ...layout.rosters].map((t) =>
        readable
          ? {
              ...t,
              columns: t.columns.map((c) =>
                isMoment(c) ? { ...c, label: c.label.replace('UTC', readable.timeZone) } : c,
              ),
            }
          : t,
      );
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
            this.sqlExportOf({
              name: src.name,
              projectId: job.projectId,
              questionnaireId: src.questionnaireId,
              versionId: src.versionId,
              language: opts.language ?? src.compiled.questionnaire.defaultLanguage,
              schema: this.config.DATABASE_SCHEMA,
              opts,
              main: { ...layout.main, rows: [] },
              rosters: layout.rosters.map((t) => ({ ...t, rows: [] })),
            }),
          ),
        );
      } else if (opts.format === 'xlsx' || opts.format === 'codebook') {
        await this.workbook(out, opts, tables, rows, readable);
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
            return csvEncoder(columns, { labels: opts.labels === 'labels', format: readable });
          const o = { label: src.name };
          return opts.format === 'sav'
            ? savEncoder(columns, stats![t]!, o)
            : dtaEncoder(columns, stats![t]!, o);
        };
        const zip = file.entries.length ? new ZipStream() : undefined;
        for (let t = 0; t < tables.length; t++) {
          const enc = encoderOf(t);
          const put = zip ? (b: Uint8Array) => out(zip.data(b)) : out;
          if (zip) await out(zip.open(file.entries[t]!));
          await put(enc.head());
          for await (const batch of rows(t)) await put(enc.rows(batch));
          await put(enc.tail());
          if (zip) await out(zip.close());
        }
        // The codebook goes with a CSV when asked: the last two entries of the zip.
        if (zip && withCodebook(opts)) {
          const book = codebookCsv(tables);
          for (const [k, data] of [book.variables, book.values].entries()) {
            await out(zip.open(file.entries[tables.length + k]!));
            await out(zip.data(data));
            await out(zip.close());
          }
        }
        if (zip) await out(zip.finish());
      }
      await writer.done();
      const size = writer.size;
      writer = undefined;
      await this.repo.inTenant(tenantId, (t) =>
        t.finishExport(exportId, {
          fileName: file.fileName,
          contentType: file.contentType,
          storageKey: `${tenantId}/${exportId}/${file.fileName}`,
          size,
          rows: interviews,
        }),
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
        await this.repo.inTenant(tenantId, (t) => t.requeueExport(exportId)).catch(() => undefined);
        throw e;
      }
      this.logger.error(`Export ${exportId} failed: ${error.message}`);
      await this.repo.inTenant(tenantId, (t) => t.failExport(exportId, error.message));
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
    const book = withCodebook(opts);
    if (tables.length === 1 && !book)
      return { fileName: `${base}.${ext}`, contentType: CONTENT_TYPES[ext], entries: [] };
    // Long rosters: one file per table, in a zip; a CSV's codebook after them.
    return {
      fileName: `${base}.zip`,
      contentType: CONTENT_TYPES.zip,
      entries: [
        ...tables.map((t, k) => (k === 0 ? `${base}.${ext}` : `${base}_${t.name}.${ext}`)),
        ...(book ? [`${base}_codebook_variables.csv`, `${base}_codebook_values.csv`] : []),
      ],
    };
  }

  /**
   * Excel, written sheet by sheet as rows come (hucre's streaming writer, which pulls the rows
   * of one sheet at a time and keeps memory flat): the data sheets (none for a codebook), then
   * the codebook of the main table and of each roster table. A data sheet past Excel's row limit
   * continues in `name_2`, with its header again.
   */
  private async workbook(
    out: (chunk: Uint8Array) => Promise<void>,
    opts: ExportBody,
    tables: TableLayout[],
    rows: (t: number) => AsyncGenerator<Cell[][]>,
    readable?: ReadableFormat,
  ) {
    const labels = opts.labels === 'labels';
    const sheets: XlsxStreamSheet[] = [];
    if (opts.format === 'xlsx')
      for (let t = 0; t < tables.length; t++) {
        const table = tables[t]!;
        sheets.push({
          name: (t === 0 ? 'data' : table.name).slice(0, 31),
          freezePane: { rows: 1 },
          rows: dataRows(table, rows(t), labels, readable),
        });
      }
    sheets.push(...codebookSheets(tables[0]!.columns));
    if (opts.format === 'codebook')
      for (const r of tables.slice(1))
        sheets.push({
          name: `variables_${r.name}`.slice(0, 31),
          rows: withHeader(
            ['name', 'label', 'type'],
            codebook({ ...r, rows: [] }).map((e) => [e.name, e.label, e.type]),
          ),
        });
    const reader = writeXlsxStreamSheets(sheets).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await out(value);
      }
    } catch (e) {
      await reader.cancel(e).catch(() => undefined);
      throw e;
    }
  }
}
