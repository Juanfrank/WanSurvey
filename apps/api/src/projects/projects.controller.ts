import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  PayloadTooLargeException,
  Post,
  Put,
  Res,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  ASSIGNMENT_MODES,
  CapiSettings,
  CatiSettings,
  CawiSettings,
  FieldworkSettings,
  Mode,
  PapiSettings,
  RetentionSettings,
  ReviewSettings,
  ShortcutSettings,
  projectSettings,
} from '@wansurvey/schema';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, can, type AuthContext } from '../common/auth-context.js';
import { DisplayName, ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { projectLogos, projects, tenants } from '../db/schema.js';

const LOGO_MAX = 512 * 1024;

/** The image type from its first bytes (the file name and declared type are not trusted). */
export function imageType(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

const ProjectFields = z.object({
  name: DisplayName,
  code: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  modesEnabled: z.array(Mode),
  timezone: z.string().min(1).max(64),
  languages: z.array(z.string().min(2).max(16)).min(1),
});
// Time zone and languages left out come from the organisation's defaults.
const ProjectBody = ProjectFields.extend({
  modesEnabled: ProjectFields.shape.modesEnabled.default([]),
  timezone: ProjectFields.shape.timezone.optional(),
  languages: ProjectFields.shape.languages.optional(),
});
// No defaults here: fields left out of a PATCH keep their value.
const ProjectPatch = ProjectFields.partial().extend({
  status: z.enum(['draft', 'active', 'closed', 'archived']).optional(),
  /** Merged into the stored settings; keys left out keep their value. */
  settings: z
    .object({
      revealToInterviewers: z.boolean(),
      assignmentMode: z.enum(ASSIGNMENT_MODES),
      cati: CatiSettings,
      capi: CapiSettings,
      cawi: CawiSettings,
      papi: PapiSettings,
      review: ReviewSettings,
      fieldwork: FieldworkSettings,
      retention: RetentionSettings,
      shortcuts: ShortcutSettings,
    })
    .partial()
    .strict()
    .optional(),
});

/** A project row with its settings' defaults filled in. */
const withSettings = <T extends { settings: unknown }>(p: T) => ({
  ...p,
  settings: projectSettings(p.settings),
});

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  /** Tenant-wide members see every project; project-scoped members see only theirs. */
  @Get()
  @RequirePermission('projects.read', { anyProject: true })
  list(@Auth() ctx: AuthContext) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      if (can(ctx.memberships, 'projects.read'))
        return (await tx.select().from(projects).orderBy(projects.name)).map(withSettings);
      const ids = ctx.memberships
        .filter((m) => m.projectId !== null && can([m], 'projects.read', m.projectId))
        .map((m) => m.projectId!);
      return ids.length
        ? (
            await tx.select().from(projects).where(inArray(projects.id, ids)).orderBy(projects.name)
          ).map(withSettings)
        : [];
    });
  }

  @Post()
  @RequirePermission('projects.create')
  @ApiBody({ schema: z.toJSONSchema(ProjectBody) as object })
  create(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(ProjectBody)) body: z.infer<typeof ProjectBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [dup] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, body.code));
      if (dup) throw new ConflictException('A project with this code already exists');
      const [org] = await tx
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId));
      const defaults = (org?.settings ?? {}) as {
        defaultLanguage?: string;
        defaultTimezone?: string;
      };
      const [project] = await tx
        .insert(projects)
        .values({
          tenantId: ctx.tenantId,
          ...body,
          timezone: body.timezone ?? defaults.defaultTimezone ?? 'UTC',
          languages: body.languages ?? [defaults.defaultLanguage ?? 'es'],
        })
        .returning();
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'project.created',
          targetType: 'project',
          targetId: project!.id,
          details: body,
        }),
      );
      return withSettings(project!);
    });
  }

  @Get(':id')
  @RequirePermission('projects.read', { projectParam: 'id' })
  get(@Auth() ctx: AuthContext, @Param('id') id: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, id));
      if (!project) throw new NotFoundException('Project not found');
      return withSettings(project);
    });
  }

  @Patch(':id')
  @RequirePermission('projects.update', { projectParam: 'id' })
  @ApiBody({ schema: z.toJSONSchema(ProjectPatch) as object })
  update(
    @Auth() ctx: AuthContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ProjectPatch)) body: z.infer<typeof ProjectPatch>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const { settings, ...fields } = body;
      const [current] = await tx
        .select({ settings: projects.settings })
        .from(projects)
        .where(eq(projects.id, id));
      if (!current) throw new NotFoundException('Project not found');
      const [project] = await tx
        .update(projects)
        .set({
          ...fields,
          ...(settings ? { settings: { ...projectSettings(current.settings), ...settings } } : {}),
        })
        .where(eq(projects.id, id))
        .returning();
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'project.updated',
          targetType: 'project',
          targetId: id,
          details: body,
        }),
      );
      return withSettings(project!);
    });
  }

  /** Uploads the project's logo (PNG, JPEG, WebP or GIF, up to 512 KB), replacing any other. */
  @Put(':id/logo')
  @RequirePermission('projects.update', { projectParam: 'id' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_MAX } }))
  uploadLogo(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
  ) {
    if (!file) throw new BadRequestException('Attach the image as "file"');
    if (file.size > LOGO_MAX) throw new PayloadTooLargeException();
    const contentType = imageType(file.buffer);
    if (!contentType)
      throw new UnprocessableEntityException({
        code: 'NOT_AN_IMAGE',
        message: 'Use a PNG, JPEG, WebP or GIF image',
      });
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [p] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, id));
      if (!p) throw new NotFoundException('Project not found');
      const now = new Date();
      await tx
        .insert(projectLogos)
        .values({ projectId: id, tenantId: ctx.tenantId, contentType, image: file.buffer })
        .onConflictDoUpdate({
          target: projectLogos.projectId,
          set: { contentType, image: file.buffer, updatedAt: now },
        });
      const [project] = await tx
        .update(projects)
        .set({ logoUpdatedAt: now })
        .where(eq(projects.id, id))
        .returning();
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'project.updated',
          targetType: 'project',
          targetId: id,
          details: { logo: contentType, size: file.size },
        }),
      );
      return withSettings(project!);
    });
  }

  @Get(':id/logo')
  @RequirePermission('projects.read', { projectParam: 'id' })
  async logo(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const logo = await this.database.withTenant(ctx.tenantId, async (tx) => {
      const [l] = await tx
        .select({ contentType: projectLogos.contentType, image: projectLogos.image })
        .from(projectLogos)
        .where(eq(projectLogos.projectId, id));
      return l;
    });
    if (!logo) throw new NotFoundException('No logo');
    res.setHeader('Content-Type', logo.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(logo.image);
  }

  @Delete(':id/logo')
  @RequirePermission('projects.update', { projectParam: 'id' })
  removeLogo(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await tx.delete(projectLogos).where(eq(projectLogos.projectId, id));
      const [project] = await tx
        .update(projects)
        .set({ logoUpdatedAt: null })
        .where(eq(projects.id, id))
        .returning();
      if (!project) throw new NotFoundException('Project not found');
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'project.updated',
          targetType: 'project',
          targetId: id,
          details: { logo: null },
        }),
      );
      return withSettings(project);
    });
  }
}
