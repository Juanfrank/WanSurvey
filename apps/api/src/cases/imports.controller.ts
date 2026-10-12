import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Put,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { CONFIG, loadConfig, type AppConfig } from '../config.js';
import { Database, type Tx } from '../db/database.js';
import { cases, contacts, sampleFields, sampleImportRows, sampleImports } from '../db/schema.js';
import { chunks, CasesService } from './cases.service.js';
import { parseSampleFile, SampleFileError } from './sample-file.js';
import { ImportMapping, suggestMapping, validateRows, type PreparedRow } from './sample-mapping.js';

const PERM = { projectParam: 'projectId' } as const;
const STAGING_HOURS = 24;

interface UploadedSample {
  originalname: string;
  size: number;
  buffer: Buffer;
}

/**
 * Sample import (spec §8.1, §13 slice 5): upload a CSV/XLSX file, map its columns, validate,
 * then commit in one transaction. Parsed rows wait in a staging table between the steps.
 */
@ApiTags('cases')
@Controller('projects/:projectId/imports')
export class ImportsController {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
    private readonly casesService: CasesService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  @RequirePermission('cases.import', PERM)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    // Multer keeps uploads in memory by default; the file is parsed and staged right away.
    FileInterceptor('file', {
      limits: { fileSize: loadConfig().IMPORT_MAX_MB * 1024 * 1024 },
    }),
  )
  async upload(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: UploadedSample | undefined,
    @Body() body: { sheet?: string },
  ) {
    if (!file) throw new BadRequestException('Attach the sample file as "file"');
    if (file.size > this.config.IMPORT_MAX_MB * 1024 * 1024) throw new PayloadTooLargeException();
    let parsed;
    try {
      parsed = await parseSampleFile(file.buffer, file.originalname, {
        sheet: typeof body?.sheet === 'string' && body.sheet ? body.sheet : undefined,
        maxRows: this.config.IMPORT_MAX_ROWS,
      });
    } catch (e) {
      if (e instanceof SampleFileError)
        throw new UnprocessableEntityException({ code: 'UNREADABLE_FILE', message: e.message });
      throw e;
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.casesService.project(tx, projectId);
      await this.cleanupStaging(tx);
      const [dup] = await tx
        .select({ id: sampleImports.id, committedAt: sampleImports.committedAt })
        .from(sampleImports)
        .where(
          and(
            eq(sampleImports.projectId, projectId),
            eq(sampleImports.sha256, sha256),
            eq(sampleImports.status, 'committed'),
          ),
        )
        .limit(1);
      const [row] = await tx
        .insert(sampleImports)
        .values({
          tenantId: ctx.tenantId,
          projectId,
          fileName: file.originalname,
          size: file.size,
          sha256,
          headers: parsed.headers,
          rows: parsed.rows.length,
          uploadedBy: ctx.userId,
        })
        .returning({ id: sampleImports.id });
      for (const [i, part] of chunks(parsed.rows).entries()) {
        await tx.insert(sampleImportRows).values(
          part.map((data, j) => ({
            tenantId: ctx.tenantId,
            importId: row!.id,
            rowNo: i * 1000 + j + 1,
            data,
          })),
        );
      }
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'cases.import_uploaded',
          targetType: 'project',
          targetId: projectId,
          details: { importId: row!.id, file: file.originalname, rows: parsed.rows.length },
        }),
      );
      return {
        id: row!.id,
        fileName: file.originalname,
        headers: parsed.headers,
        rows: parsed.rows.length,
        preview: parsed.rows.slice(0, 20),
        sheets: parsed.sheets ?? null,
        encoding: parsed.encoding ?? null,
        delimiter: parsed.delimiter ?? null,
        suggested: suggestMapping(parsed.headers, parsed.rows.slice(0, 50)),
        duplicateOf: dup?.id ?? null,
      };
    });
  }

  @Get()
  @RequirePermission('cases.import', PERM)
  list(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      tx
        .select({
          id: sampleImports.id,
          fileName: sampleImports.fileName,
          rows: sampleImports.rows,
          status: sampleImports.status,
          report: sampleImports.report,
          createdAt: sampleImports.createdAt,
          committedAt: sampleImports.committedAt,
        })
        .from(sampleImports)
        .where(eq(sampleImports.projectId, projectId))
        .orderBy(desc(sampleImports.createdAt))
        .limit(50),
    );
  }

  @Get(':importId')
  @RequirePermission('cases.import', PERM)
  get(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('importId', ParseUUIDPipe) importId: string,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const imp = await this.load(tx, projectId, importId);
      const preview = await tx
        .select({ data: sampleImportRows.data })
        .from(sampleImportRows)
        .where(eq(sampleImportRows.importId, importId))
        .orderBy(asc(sampleImportRows.rowNo))
        .limit(20);
      return { ...imp, preview: preview.map((p) => p.data) };
    });
  }

  /** Stores the column mapping and returns the validation report for it. */
  @Put(':importId/mapping')
  @RequirePermission('cases.import', PERM)
  @ApiBody({ schema: z.toJSONSchema(ImportMapping) as object })
  mapping(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('importId', ParseUUIDPipe) importId: string,
    @Body(new ZodPipe(ImportMapping)) mapping: ImportMapping,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const imp = await this.load(tx, projectId, importId);
      if (imp.status === 'committed')
        throw new ConflictException('This import is already committed');
      const headers = imp.headers as string[];
      this.checkMapping(mapping, headers.length);
      const { report } = await this.validate(tx, projectId, importId, headers, mapping);
      await tx
        .update(sampleImports)
        .set({ mapping, report, status: 'validated' })
        .where(eq(sampleImports.id, importId));
      return report;
    });
  }

  @Post(':importId/commit')
  @HttpCode(200)
  @RequirePermission('cases.import', PERM)
  commit(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('importId', ParseUUIDPipe) importId: string,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [imp] = await tx
        .select()
        .from(sampleImports)
        .where(and(eq(sampleImports.id, importId), eq(sampleImports.projectId, projectId)))
        .for('update');
      if (!imp) throw new NotFoundException('Import not found');
      if (imp.status === 'committed')
        throw new ConflictException('This import is already committed');
      if (imp.status !== 'validated' || !imp.mapping)
        throw new ConflictException({
          code: 'NOT_VALIDATED',
          message: 'Map and validate the file first',
        });
      const mapping = ImportMapping.parse(imp.mapping);
      const headers = imp.headers as string[];
      const { report, prepared } = await this.validate(tx, projectId, importId, headers, mapping);
      if (report.invalid && !mapping.skipInvalid) {
        throw new UnprocessableEntityException({
          code: 'INVALID_ROWS',
          message: `${report.invalid} rows are invalid; fix the file or choose to skip them`,
          report,
        });
      }

      await this.upsertFields(tx, ctx.tenantId, projectId, mapping);
      const rows = prepared.filter((r) => r.valid);
      const fresh = rows.filter((r) => !r.exists);
      const updates = mapping.existing === 'update' ? rows.filter((r) => r.exists) : [];
      const created: string[] = [];
      for (const part of chunks(fresh)) {
        const ins = await tx
          .insert(cases)
          .values(
            part.map((r) => ({
              tenantId: ctx.tenantId,
              projectId,
              externalId: r.externalId,
              sample: r.sample,
              priority: r.priority ?? 0,
              modePreference: r.modePreference ?? null,
              importId,
            })),
          )
          .returning({ id: cases.id, externalId: cases.externalId });
        const byExt = new Map(ins.map((x) => [x.externalId, x.id]));
        await this.insertContacts(tx, ctx.tenantId, part, byExt);
        created.push(...ins.map((x) => x.id));
      }
      const updated: string[] = [];
      for (const part of chunks(updates)) {
        const existing = await tx
          .select({ id: cases.id, externalId: cases.externalId })
          .from(cases)
          .where(
            and(
              eq(cases.projectId, projectId),
              inArray(
                cases.externalId,
                part.map((r) => r.externalId),
              ),
            ),
          );
        const byExt = new Map(existing.map((x) => [x.externalId, x.id]));
        for (const r of part) {
          const id = byExt.get(r.externalId)!;
          await tx
            .update(cases)
            .set({
              sample: sql`${cases.sample} || ${JSON.stringify(r.sample)}::jsonb`,
              ...(r.priority !== undefined ? { priority: r.priority } : {}),
              ...(r.modePreference ? { modePreference: r.modePreference } : {}),
              updatedAt: new Date(),
            })
            .where(eq(cases.id, id));
          if (r.contacts.length) await tx.delete(contacts).where(eq(contacts.caseId, id));
        }
        await this.insertContacts(
          tx,
          ctx.tenantId,
          part.filter((r) => r.contacts.length),
          byExt,
        );
        updated.push(...existing.map((x) => x.id));
      }
      await this.casesService.events(tx, ctx.tenantId, ctx.userId, [
        ...created.map((caseId) => ({ caseId, type: 'imported', details: { importId } })),
        ...updated.map((caseId) => ({ caseId, type: 'updated_by_import', details: { importId } })),
      ]);
      // In pool mode interviewers claim cases themselves; rules only run when asked.
      const pool = (await this.casesService.settings(tx, projectId)).assignmentMode === 'pool';
      const assigned =
        created.length && !pool
          ? await this.casesService.applyRules(tx, ctx, projectId, { onlyCaseIds: created })
          : 0;
      await tx.delete(sampleImportRows).where(eq(sampleImportRows.importId, importId));
      const summary = {
        created: created.length,
        updated: updated.length,
        skipped: report.invalid,
        assigned,
      };
      await tx
        .update(sampleImports)
        .set({ status: 'committed', committedAt: new Date(), report: { ...report, summary } })
        .where(eq(sampleImports.id, importId));
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'cases.imported',
          targetType: 'project',
          targetId: projectId,
          details: { importId, file: imp.fileName, ...summary },
        }),
      );
      return summary;
    });
  }

  /** The validation issues as CSV, for fixing the file in a spreadsheet. */
  @Get(':importId/report.csv')
  @RequirePermission('cases.import', PERM)
  @Header('content-type', 'text/csv; charset=utf-8')
  async reportCsv(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('importId', ParseUUIDPipe) importId: string,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const imp = await this.load(tx, projectId, importId);
      if (!imp.mapping) throw new ConflictException('Map and validate the file first');
      const mapping = ImportMapping.parse(imp.mapping);
      const { report } = await this.validate(
        tx,
        projectId,
        importId,
        imp.headers as string[],
        mapping,
        Infinity,
      );
      const q = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
      const lines = ['row,issue,column,value'];
      for (const i of report.issues)
        for (const e of i.examples) lines.push([e.row, i.code, q(e.column), q(e.value)].join(','));
      return lines.join('\n') + '\n';
    });
  }

  // -------------------------------------------------------------------------

  private async load(tx: Tx, projectId: string, importId: string) {
    const [imp] = await tx
      .select()
      .from(sampleImports)
      .where(and(eq(sampleImports.id, importId), eq(sampleImports.projectId, projectId)));
    if (!imp) throw new NotFoundException('Import not found');
    return imp;
  }

  private checkMapping(mapping: ImportMapping, width: number) {
    if (mapping.columns.length !== width)
      throw new BadRequestException(`The mapping needs one entry per column (${width})`);
    if (mapping.columns.filter((c) => c.kind === 'externalId').length !== 1)
      throw new BadRequestException({
        code: 'NO_ID_COLUMN',
        message: 'Choose exactly one column as the case id',
      });
    const fields = mapping.columns.flatMap((c) => (c.kind === 'sample' ? [c.field] : []));
    const dup = fields.find((f, i) => fields.indexOf(f) !== i);
    if (dup) throw new BadRequestException(`Field ${dup} is mapped twice`);
  }

  private async stagedRows(tx: Tx, importId: string): Promise<string[][]> {
    const rows = await tx
      .select({ data: sampleImportRows.data })
      .from(sampleImportRows)
      .where(eq(sampleImportRows.importId, importId))
      .orderBy(asc(sampleImportRows.rowNo));
    return rows.map((r) => r.data as string[]);
  }

  private async validate(
    tx: Tx,
    projectId: string,
    importId: string,
    headers: string[],
    mapping: ImportMapping,
    maxExamples = 5,
  ) {
    const rows = await this.stagedRows(tx, importId);
    const idCol = mapping.columns.findIndex((c) => c.kind === 'externalId');
    const ids = [...new Set(rows.map((r) => r[idCol] ?? '').filter(Boolean))];
    const existing = new Set<string>();
    for (const part of chunks(ids)) {
      const found = await tx
        .select({ externalId: cases.externalId })
        .from(cases)
        .where(and(eq(cases.projectId, projectId), inArray(cases.externalId, part)));
      found.forEach((f) => existing.add(f.externalId));
    }
    return validateRows(headers, rows, mapping, existing, maxExamples);
  }

  private async insertContacts(
    tx: Tx,
    tenantId: string,
    rows: PreparedRow[],
    idByExternal: Map<string, string>,
  ) {
    const values = rows.flatMap((r) =>
      r.contacts.map((c) => ({
        tenantId,
        caseId: idByExternal.get(r.externalId)!,
        type: c.type,
        value: c.value,
        label: c.label,
      })),
    );
    for (const part of chunks(values)) if (part.length) await tx.insert(contacts).values(part);
  }

  private async upsertFields(tx: Tx, tenantId: string, projectId: string, mapping: ImportMapping) {
    let position = 0;
    for (const c of mapping.columns) {
      if (c.kind !== 'sample') continue;
      await tx
        .insert(sampleFields)
        .values({
          tenantId,
          projectId,
          name: c.field,
          type: c.type,
          pii: c.pii,
          position: position++,
        })
        .onConflictDoUpdate({
          target: [sampleFields.projectId, sampleFields.name],
          set: { type: c.type, pii: sql`${sampleFields.pii} or ${c.pii}` },
        });
    }
  }

  /** Staging rows of imports that were never committed are dropped after a day. */
  private async cleanupStaging(tx: Tx) {
    const stale = await tx
      .select({ id: sampleImports.id })
      .from(sampleImports)
      .where(
        and(
          ne(sampleImports.status, 'committed'),
          lt(sampleImports.createdAt, new Date(Date.now() - STAGING_HOURS * 3600_000)),
        ),
      );
    if (!stale.length) return;
    const ids = stale.map((s) => s.id);
    await tx.delete(sampleImportRows).where(inArray(sampleImportRows.importId, ids));
    await tx.update(sampleImports).set({ status: 'failed' }).where(inArray(sampleImports.id, ids));
  }
}
