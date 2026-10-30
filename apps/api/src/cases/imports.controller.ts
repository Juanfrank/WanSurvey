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
  Query,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { safeCell } from '@wansurvey/exporters';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { CONFIG, loadConfig, type AppConfig } from '../config.js';
import {
  SAMPLE_REPO,
  type ImportView,
  type SampleRepo,
  type SampleTx,
} from '../sampling/sampling-repo.js';
import { chunks, CasesService } from './cases.service.js';
import { SamplingService } from '../sampling/sampling.service.js';
import { CrossChecker } from '../sampling/cross-check.js';
import { CrossCheck } from '@wansurvey/schema/sampling';

const CrossCheckList = z.array(CrossCheck);
import { parseSampleFile, SampleFileError } from './sample-file.js';
import { ImportMapping, suggestMapping, validateRows, type PreparedRow } from './sample-mapping.js';

const PERM = { projectParam: 'projectId' } as const;
const STAGING_HOURS = 24;
const ListQuery = z.object({ questionnaireId: z.uuid().optional() });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    @Inject(SAMPLE_REPO) private readonly repo: SampleRepo,
    private readonly audit: AuditService,
    private readonly casesService: CasesService,
    private readonly sampling: SamplingService,
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
    @Body()
    body: { sheet?: string; target?: string; sourceLabel?: string; questionnaireId?: string },
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.casesService.project(t, projectId);
      // The cases (or frame) of one questionnaire; without one, the project's first.
      const wanted = typeof body?.questionnaireId === 'string' ? body.questionnaireId : '';
      if (wanted && !UUID.test(wanted)) throw new BadRequestException('Invalid questionnaireId');
      const questionnaireId = await this.casesService.questionnaireFor(
        t,
        projectId,
        wanted || null,
      );
      await t.abandonStale(new Date(Date.now() - STAGING_HOURS * 3600_000));
      const dup = await t.committedImport(projectId, questionnaireId, sha256);
      const id = await t.createImport({
        projectId,
        questionnaireId,
        fileName: file.originalname,
        size: file.size,
        sha256,
        headers: parsed.headers,
        rows: parsed.rows.length,
        // Units for the sampling frame (S1) rather than cases straight away.
        target: body?.target === 'frame' ? 'frame' : 'cases',
        sourceLabel:
          typeof body?.sourceLabel === 'string' && body.sourceLabel.trim()
            ? body.sourceLabel.trim().slice(0, 100)
            : null,
        uploadedBy: ctx.userId,
      });
      await t.stageRows(id, parsed.rows);
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'cases.import_uploaded',
          targetType: 'project',
          targetId: projectId,
          details: { importId: id, file: file.originalname, rows: parsed.rows.length },
        }),
      );
      return {
        id,
        fileName: file.originalname,
        headers: parsed.headers,
        rows: parsed.rows.length,
        preview: parsed.rows.slice(0, 20),
        sheets: parsed.sheets ?? null,
        encoding: parsed.encoding ?? null,
        delimiter: parsed.delimiter ?? null,
        suggested: suggestMapping(parsed.headers, parsed.rows.slice(0, 50)),
        duplicateOf: dup ?? null,
      };
    });
  }

  @Get()
  @RequirePermission('cases.import', PERM)
  list(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => t.listImports(projectId, q.questionnaireId));
  }

  @Get(':importId')
  @RequirePermission('cases.import', PERM)
  get(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('importId', ParseUUIDPipe) importId: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const imp = await this.load(t, projectId, importId);
      return { ...imp, preview: await t.stagedRows(importId, 20) };
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const imp = await this.load(t, projectId, importId);
      if (imp.status === 'committed')
        throw new ConflictException('This import is already committed');
      const headers = imp.headers as string[];
      this.checkMapping(mapping, headers.length);
      const { report } = await this.validate(
        t,
        projectId,
        imp.questionnaireId,
        importId,
        headers,
        mapping,
      );
      await t.updateImport(importId, { mapping, report, status: 'validated' });
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const imp = await t.importRow(projectId, importId, true);
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
      const q = imp.questionnaireId;
      const { report, prepared } = await this.validate(t, projectId, q, importId, headers, mapping);
      if (report.invalid && !mapping.skipInvalid) {
        throw new UnprocessableEntityException({
          code: 'INVALID_ROWS',
          message: `${report.invalid} rows are invalid; fix the file or choose to skip them`,
          report,
        });
      }

      await t.upsertFields(
        projectId,
        mapping.columns.flatMap((c) =>
          c.kind === 'sample' ? [{ field: c.field, type: c.type, pii: c.pii }] : [],
        ),
      );
      if (imp.target === 'frame')
        return this.commitFrame(t, ctx, projectId, imp, mapping, report, prepared);
      const rows = prepared.filter((r) => r.valid);
      const fresh = rows.filter((r) => !r.exists && !r.crossChecked);
      const updates = mapping.existing === 'update' ? rows.filter((r) => r.exists) : [];
      const created: string[] = [];
      // Personal fields are sealed (H1); the field list is the one just saved.
      const pii = await this.casesService.piiFields(t, projectId);
      for (const part of chunks(fresh)) {
        const ins = await t.insertCases(
          projectId,
          part.map((r) => ({
            externalId: r.externalId,
            questionnaireId: q,
            ...this.casesService.pii.seal(r.sample, pii),
            priority: r.priority ?? 0,
            modePreference: r.modePreference ?? null,
            importId,
          })),
        );
        const byExt = new Map(ins.map((x) => [x.externalId, x.id]));
        await this.insertContacts(t, part, byExt);
        created.push(...ins.map((x) => x.id));
      }
      const updated: string[] = [];
      for (const part of chunks(updates)) {
        const existing = await t.casesByExternal(
          projectId,
          q,
          part.map((r) => r.externalId),
        );
        const byExt = new Map(existing.map((x) => [x.externalId, x]));
        for (const r of part) {
          const old = byExt.get(r.externalId)!;
          const id = old.id;
          await t.updateFromImport(id, {
            ...this.casesService.pii.seal({ ...this.casesService.pii.read(old), ...r.sample }, pii),
            ...(r.priority !== undefined ? { priority: r.priority } : {}),
            ...(r.modePreference ? { modePreference: r.modePreference } : {}),
          });
          if (r.contacts.length) await t.deleteContactsOf(id);
        }
        await this.insertContacts(
          t,
          part.filter((r) => r.contacts.length),
          new Map([...byExt].map(([k, v]) => [k, v.id])),
        );
        updated.push(...existing.map((x) => x.id));
      }
      await this.casesService.events(t, ctx.tenantId, ctx.userId, [
        ...created.map((caseId) => ({ caseId, type: 'imported', details: { importId } })),
        ...updated.map((caseId) => ({ caseId, type: 'updated_by_import', details: { importId } })),
      ]);
      // In pool mode interviewers claim cases themselves; rules only run when asked.
      const pool = (await this.casesService.settings(t, projectId)).assignmentMode === 'pool';
      const assigned =
        created.length && !pool
          ? await this.casesService.applyRules(t, ctx, projectId, {
              onlyCaseIds: created,
              questionnaireId: q,
            })
          : 0;
      await t.deleteStaged(importId);
      const summary = {
        created: created.length,
        updated: updated.length,
        skipped: report.invalid,
        /** Not made: the same person answered recently (cross-case checks). */
        crossChecked: rows.filter((r) => r.crossChecked && !r.exists).length,
        assigned,
      };
      await t.updateImport(importId, {
        status: 'committed',
        committedAt: new Date(),
        report: { ...report, summary },
      });
      await t.audit(
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const imp = await this.load(t, projectId, importId);
      if (!imp.mapping) throw new ConflictException('Map and validate the file first');
      const mapping = ImportMapping.parse(imp.mapping);
      const { report } = await this.validate(
        t,
        projectId,
        imp.questionnaireId,
        importId,
        imp.headers as string[],
        mapping,
        Infinity,
      );
      const q = (s: string | number) => `"${safeCell(String(s)).replace(/"/g, '""')}"`;
      const lines = ['row,issue,column,value'];
      for (const i of report.issues)
        for (const e of i.examples) lines.push([e.row, i.code, q(e.column), q(e.value)].join(','));
      return lines.join('\n') + '\n';
    });
  }

  // -------------------------------------------------------------------------

  private async load(t: SampleTx, projectId: string, importId: string) {
    const imp = await t.importRow(projectId, importId);
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

  private async validate(
    t: SampleTx,
    projectId: string,
    q: string | null,
    importId: string,
    headers: string[],
    mapping: ImportMapping,
    maxExamples = 5,
  ) {
    const rows = await t.stagedRows(importId);
    const idCol = mapping.columns.findIndex((c) => c.kind === 'externalId');
    const ids = [...new Set(rows.map((r) => r[idCol] ?? '').filter(Boolean))];
    const existing = new Set<string>();
    for (const part of chunks(ids))
      (await t.casesByExternal(projectId, q, part)).forEach((f) => existing.add(f.externalId));
    const result = validateRows(headers, rows, mapping, existing, maxExamples);
    await this.flagElsewhere(t, projectId, result, maxExamples);
    await this.flagCrossChecks(t, projectId, q, result, maxExamples);
    return result;
  }

  /**
   * The plan's cross-case checks (S1): rows of people who answered recently are marked and
   * reported (`cross_check`); new cases are not made for them. In a frame file the units stay
   * in the frame and the selection leaves them out with that reason.
   */
  private async flagCrossChecks(
    t: SampleTx,
    projectId: string,
    q: string | null,
    { report, prepared }: ReturnType<typeof validateRows>,
    maxExamples: number,
  ) {
    const plan = await t.plan(projectId, q);
    const rules = CrossCheckList.parse(plan?.crossChecks ?? []);
    const checker = await CrossChecker.load(t, this.casesService.pii, projectId, rules);
    if (!checker) return;
    const hit = prepared.filter((r) => r.valid && checker.check(r) !== null);
    if (!hit.length) return;
    for (const r of hit) r.crossChecked = true;
    report.toCreate -= hit.filter((r) => !r.exists).length;
    report.issues.push({
      code: 'cross_check',
      count: hit.length,
      blocking: false,
      examples: hit.slice(0, maxExamples).map((r) => ({
        row: r.rowNo,
        column: '',
        value: r.externalId,
      })),
    });
  }

  /**
   * Adds a non-blocking `duplicate_elsewhere` issue for rows whose phone or e-mail is already
   * on a case of another project, with project names and counts only (no personal values).
   */
  private async flagElsewhere(
    t: SampleTx,
    projectId: string,
    { report, prepared }: ReturnType<typeof validateRows>,
    maxExamples: number,
  ) {
    const items = prepared
      .filter((r) => r.valid)
      .flatMap((r) =>
        r.contacts
          .filter((c) => c.type !== 'address')
          .map((c) => ({ key: String(r.rowNo), type: c.type, value: c.value })),
      );
    if (!items.length) return;
    const found = await this.casesService.matchesElsewhere(t, projectId, items);
    if (!found.size) return;
    const perProject = new Map<string, { projectId: string; name: string; rows: number }>();
    for (const projects of found.values())
      for (const p of projects) {
        const e = perProject.get(p.projectId) ?? { projectId: p.projectId, name: p.name, rows: 0 };
        e.rows++;
        perProject.set(p.projectId, e);
      }
    const rows = [...found.keys()].map(Number).sort((a, b) => a - b);
    report.elsewhere = [...perProject.values()].sort((a, b) => a.name.localeCompare(b.name));
    report.issues.push({
      code: 'duplicate_elsewhere',
      count: rows.length,
      blocking: false,
      examples: rows.slice(0, maxExamples).map((row) => ({
        row,
        column: found
          .get(String(row))!
          .map((p) => p.name)
          .join(', '),
        value: '',
      })),
    });
  }

  /**
   * Units for the sampling frame (S1): kept apart from cases until the plan selects them.
   * Existing units are updated when the mapping says so; nothing is selected here.
   */
  private async commitFrame(
    t: SampleTx,
    ctx: AuthContext,
    projectId: string,
    imp: ImportView,
    mapping: ImportMapping,
    report: { invalid: number },
    prepared: PreparedRow[],
  ) {
    const q = imp.questionnaireId;
    const plan = await t.plan(projectId, q);
    // Once selected, units already in the frame never change (decision 6). New units are
    // added: a census or a non-probability design takes them in as cases at once ("added");
    // a probability sample keeps them for a later batch.
    const selected = plan?.status === 'selected';
    const probability = (plan?.design as { family?: string } | undefined)?.family === 'probability';
    const adding = selected && !probability;
    const rows = prepared.filter((r) => r.valid);
    const pii = await this.casesService.piiFields(t, projectId);
    const existing = await t.frameExternalIds(projectId, q);
    let created = 0;
    let updated = 0;
    const added: string[] = [];
    for (const part of chunks(rows)) {
      const fresh = part.filter((r) => !existing.has(r.externalId));
      if (fresh.length) {
        const ids = await t.insertUnits(
          fresh.map((r) => {
            const sealed = this.casesService.pii.seal(r.sample, pii);
            return {
              projectId,
              questionnaireId: q,
              externalId: r.externalId,
              sourceLabel: imp.sourceLabel,
              // Frame units keep the sealed sample, without the search index of cases.
              sample: sealed.sample,
              samplePii: sealed.samplePii,
              contacts: r.contacts,
              importId: imp.id,
            };
          }),
        );
        added.push(...ids);
        created += fresh.length;
      }
      if (mapping.existing === 'update' && !selected)
        for (const r of part.filter((x) => existing.has(x.externalId))) {
          const sealed = this.casesService.pii.seal(r.sample, pii);
          await t.updateUnit(projectId, q, r.externalId, {
            sample: sealed.sample,
            samplePii: sealed.samplePii,
            contacts: r.contacts,
            sourceLabel: imp.sourceLabel,
          });
          updated++;
        }
    }
    await t.deleteStaged(imp.id);
    const addedCases = adding ? await this.sampling.addUnits(t, ctx, projectId, q, added) : 0;
    const summary = {
      created,
      updated,
      skipped: report.invalid,
      assigned: 0,
      frame: true,
      ...(adding ? { added: addedCases } : {}),
    };
    await t.updateImport(imp.id, {
      status: 'committed',
      committedAt: new Date(),
      report: { ...report, summary },
    });
    await t.audit(
      this.audit.fromContext(ctx, {
        action: 'cases.imported',
        targetType: 'project',
        targetId: projectId,
        details: { importId: imp.id, file: imp.fileName, target: 'frame', ...summary },
      }),
    );
    return summary;
  }

  private async insertContacts(
    t: SampleTx,
    rows: PreparedRow[],
    idByExternal: Map<string, string>,
  ) {
    await t.insertContacts(
      rows.flatMap((r) =>
        r.contacts.map((c) => ({
          caseId: idByExternal.get(r.externalId)!,
          type: c.type,
          value: c.value,
          label: c.label,
        })),
      ),
    );
  }
}
