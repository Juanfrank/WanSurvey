import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
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
  AudioSettingsInput,
  NoticeSettings,
  CapiSettings,
  CatiSettings,
  EarlyExitSettings,
  PublishApprovalSettings,
  ContactRules,
  CleaningSettings,
  CawiSettings,
  FieldworkSettings,
  Mode,
  PapiSettings,
  RetentionSettings,
  ReviewSettings,
  ShortcutSettings,
  projectSettings,
} from '@wansurvey/schema';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, can, type AuthContext } from '../common/auth-context.js';
import { DisplayName, ZodPipe } from '../common/zod.js';
import { ruleProblem } from '../cases/cleaning.js';
import { ORG_REPO, type OrgRepo } from './org-repo.js';

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
/** Days after which a new project removes the personal data of finished cases, until changed. */
export const DEFAULT_RETENTION_DAYS = 365;

const ProjectPatch = ProjectFields.partial().extend({
  status: z.enum(['draft', 'active', 'closed', 'archived']).optional(),
  /** Merged into the stored settings; keys left out keep their value. */
  settings: z
    .object({
      revealToInterviewers: z.boolean(),
      assignmentMode: z.enum(ASSIGNMENT_MODES),
      cati: CatiSettings,
      earlyExit: EarlyExitSettings,
      publishApproval: PublishApprovalSettings,
      contactRules: ContactRules,
      cleaning: CleaningSettings,
      capi: CapiSettings,
      audio: AudioSettingsInput,
      notice: NoticeSettings,
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
    @Inject(ORG_REPO) private readonly repo: OrgRepo,
    private readonly audit: AuditService,
  ) {}

  /** Tenant-wide members see every project; project-scoped members see only theirs. */
  @Get()
  @RequirePermission('projects.read', { anyProject: true })
  list(@Auth() ctx: AuthContext) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      if (can(ctx.memberships, 'projects.read')) return (await t.projects()).map(withSettings);
      const ids = ctx.memberships
        .filter((m) => m.projectId !== null && can([m], 'projects.read', m.projectId))
        .map((m) => m.projectId!);
      return (await t.projects(ids)).map(withSettings);
    });
  }

  @Post()
  @RequirePermission('projects.create')
  @ApiBody({ schema: z.toJSONSchema(ProjectBody) as object })
  create(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(ProjectBody)) body: z.infer<typeof ProjectBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      if (await t.codeTaken(body.code))
        throw new ConflictException('A project with this code already exists');
      const org = await t.tenant();
      const defaults = (org?.settings ?? {}) as {
        defaultLanguage?: string;
        defaultTimezone?: string;
      };
      const created = await t.createProject({
        name: body.name,
        code: body.code,
        modesEnabled: body.modesEnabled,
        timezone: body.timezone ?? defaults.defaultTimezone ?? 'UTC',
        languages: body.languages ?? [defaults.defaultLanguage ?? 'es'],
      });
      // A new project starts with a retention period (personal data of finished cases is removed
      // after a year); the organisation changes it, or clears it knowingly. Projects that
      // already exist are not touched: removing data is not something to start by itself.
      const project =
        (await t.updateProject(created.id, {
          settings: { retention: { anonymiseAfterDays: DEFAULT_RETENTION_DAYS } },
        })) ?? created;
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'project.created',
          targetType: 'project',
          targetId: project.id,
          details: body,
        }),
      );
      return withSettings(project);
    });
  }

  @Get(':id')
  @RequirePermission('projects.read', { projectParam: 'id' })
  get(@Auth() ctx: AuthContext, @Param('id') id: string) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const project = await t.project(id);
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      // Each wording of the recording consent has its own version, kept with every answer.
      if (body.settings?.audio) {
        const current = await t.project(id);
        if (!current) throw new NotFoundException('Project not found');
        const before = projectSettings(current.settings).audio;
        const next = body.settings.audio;
        if (next.consentText !== before.consentText && next.consentVersion <= before.consentVersion)
          body.settings.audio = { ...next, consentVersion: before.consentVersion + 1 };
      }
      // Each wording of the information notice has its own version, kept with every answer.
      if (body.settings?.notice) {
        const current = await t.project(id);
        if (!current) throw new NotFoundException('Project not found');
        const before = projectSettings(current.settings).notice;
        const next = body.settings.notice;
        if (next.text !== before.text && next.version <= before.version)
          body.settings.notice = { ...next, version: before.version + 1 };
      }
      // A cleaning rule is checked as it is saved: it must read, and its patterns be valid.
      for (const r of body.settings?.cleaning?.rules ?? []) {
        const problem = ruleProblem(r.expression);
        if (problem)
          throw new BadRequestException({
            code: 'CLEANING_RULE_INVALID',
            message: `${r.name}: ${problem}`,
            ruleId: r.id,
          });
      }
      const project = await t.updateProject(id, body);
      if (!project) throw new NotFoundException('Project not found');
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'project.updated',
          targetType: 'project',
          targetId: id,
          details: body,
        }),
      );
      return withSettings(project);
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const project = await t.setLogo(id, { contentType, image: file.buffer });
      if (!project) throw new NotFoundException('Project not found');
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'project.updated',
          targetType: 'project',
          targetId: id,
          details: { logo: contentType, size: file.size },
        }),
      );
      return withSettings(project);
    });
  }

  @Get(':id/logo')
  @RequirePermission('projects.read', { projectParam: 'id' })
  async logo(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const logo = await this.repo.inTenant(ctx.tenantId, (t) => t.logo(id));
    if (!logo) throw new NotFoundException('No logo');
    res.setHeader('Content-Type', logo.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(logo.image);
  }

  @Delete(':id/logo')
  @RequirePermission('projects.update', { projectParam: 'id' })
  removeLogo(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const project = await t.removeLogo(id);
      if (!project) throw new NotFoundException('Project not found');
      await t.audit(
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
