import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UnprocessableEntityException,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { and, eq } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { Auth, can, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { interviews, papiScanBatches, papiScanPages } from '../db/schema.js';
import { FormsQuery } from './papi.service.js';
import { ScansService } from './scans.service.js';

const PERM = { projectParam: 'projectId' } as const;
/** Each PDF up to 60 MB, up to 20 at once. */
const SCAN_MAX = 60 * 1024 * 1024;
const KEYERS = ['dataentry.key', 'cases.read_all'] as const;

/** Machine-readable paper forms: download to print, upload the scans, second round. */
@ApiTags('papi')
@Controller()
export class ScansController {
  constructor(
    private readonly database: Database,
    private readonly scans: ScansService,
  ) {}

  /** The chosen cases' forms as one PDF, ready to print and read back by machine. */
  @Get('projects/:projectId/papi/scan-forms.pdf')
  @RequirePermission(['cases.read_all', 'cases.read_assigned'], PERM)
  async formsPdf(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(FormsQuery)) q: z.infer<typeof FormsQuery>,
    @Res() res: Response,
  ) {
    const out = await this.database.withTenant(ctx.tenantId, (tx) =>
      this.scans.formsPdf(tx, ctx, projectId, q),
    );
    const name = out.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'forms';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="forms.pdf"; filename*=UTF-8''${encodeURIComponent(name)}.pdf`,
    );
    res.setHeader('X-Form-Count', String(out.count));
    res.end(out.pdf);
  }

  /** Uploads scanned PDFs (each may hold many forms); they are read in the background. */
  @Post('projects/:projectId/papi/scans')
  @HttpCode(202)
  @RequirePermission([...KEYERS], PERM)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FilesInterceptor('files', 20, { limits: { fileSize: SCAN_MAX } }))
  upload(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFiles() files: { originalname: string; buffer: Buffer }[] | undefined,
  ) {
    if (!files?.length) throw new BadRequestException('Attach the PDFs as "files"');
    for (const f of files)
      if (f.buffer.subarray(0, 5).toString('latin1') !== '%PDF-')
        throw new UnprocessableEntityException({
          code: 'NOT_A_PDF',
          message: `${f.originalname} is not a PDF`,
        });
    return this.scans.upload(ctx, projectId, files);
  }

  /** The uploaded batches, the forms found and how far each is. */
  @Get('projects/:projectId/papi/scans')
  @RequirePermission([...KEYERS], PERM)
  list(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.scans.list(tx, projectId));
  }

  /** A scanned page's image (to show where a question is on paper). */
  @Get('projects/:projectId/papi/scans/pages/:pageId')
  @RequirePermission([...KEYERS, 'interviews.review'], PERM)
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'private, max-age=86400')
  async page(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Res() res: Response,
  ) {
    const image = await this.database.withTenant(ctx.tenantId, async (tx) => {
      const [p] = await tx
        .select({ id: papiScanPages.id })
        .from(papiScanPages)
        .innerJoin(papiScanBatches, eq(papiScanBatches.id, papiScanPages.batchId))
        .where(and(eq(papiScanPages.id, pageId), eq(papiScanBatches.projectId, projectId)));
      if (!p) throw new NotFoundException('Page not found');
      return this.scans.pageImage(tx, pageId);
    });
    res.end(image);
  }

  /** Takes a read form to finish it in the keying screen (the second round). */
  @Post('projects/:projectId/papi/scans/forms/:formId/claim')
  @HttpCode(200)
  @RequirePermission('dataentry.key', PERM)
  claim(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.scans.claim(tx, ctx, projectId, formId),
    );
  }

  /** For an interview read from a scan: per question its reason and where it is on paper. */
  @Get('interviews/:id/scan')
  @RequirePermission(['dataentry.key', 'interviews.conduct', 'interviews.review'], {
    anyProject: true,
  })
  forInterview(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx.select().from(interviews).where(eq(interviews.id, id));
      if (
        !row ||
        !(
          row.interviewerId === ctx.userId ||
          can(ctx.memberships, 'interviews.review', row.projectId) ||
          can(ctx.memberships, 'cases.read_all', row.projectId)
        )
      )
        throw new NotFoundException('Interview not found');
      return { projectId: row.projectId, ...(await this.scans.forInterview(tx, id)) };
    });
  }
}
