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
import { Mode } from '@wansurvey/schema';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, can, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { projects } from '../db/schema.js';

const ProjectBody = z.object({
  name: z.string().min(1).max(200),
  code: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  modesEnabled: z.array(Mode).default([]),
  timezone: z.string().min(1).max(64).default('UTC'),
  languages: z.array(z.string().min(2).max(16)).min(1).default(['en']),
});
const ProjectPatch = ProjectBody.partial().extend({
  status: z.enum(['draft', 'active', 'closed', 'archived']).optional(),
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
        return tx.select().from(projects).orderBy(projects.name);
      const ids = ctx.memberships
        .filter((m) => m.projectId !== null && can([m], 'projects.read', m.projectId))
        .map((m) => m.projectId!);
      return ids.length
        ? tx.select().from(projects).where(inArray(projects.id, ids)).orderBy(projects.name)
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
      return project;
    });
  }

  @Get(':id')
  @RequirePermission('projects.read', { projectParam: 'id' })
  get(@Auth() ctx: AuthContext, @Param('id') id: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, id));
      if (!project) throw new NotFoundException('Project not found');
      return project;
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
      const [project] = await tx.update(projects).set(body).where(eq(projects.id, id)).returning();
      if (!project) throw new NotFoundException('Project not found');
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
      return project;
    });
  }
}
