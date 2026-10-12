import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import {
  ASSIGNMENT_MODES,
  CapiSettings,
  CatiSettings,
  Mode,
  projectSettings,
} from '@wansurvey/schema';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, can, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { projects } from '../db/schema.js';

const ProjectFields = z.object({
  name: z.string().min(1).max(200),
  code: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  modesEnabled: z.array(Mode),
  timezone: z.string().min(1).max(64),
  languages: z.array(z.string().min(2).max(16)).min(1),
});
const ProjectBody = ProjectFields.extend({
  modesEnabled: ProjectFields.shape.modesEnabled.default([]),
  timezone: ProjectFields.shape.timezone.default('UTC'),
  languages: ProjectFields.shape.languages.default(['es']),
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
      const [project] = await tx
        .insert(projects)
        .values({ tenantId: ctx.tenantId, ...body })
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
}
