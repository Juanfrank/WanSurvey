import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { ROLE_RANK, ROLES, Role } from '@wansurvey/schema';
import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import {
  Auth,
  can,
  RequirePermission,
  tenantRank,
  type AuthContext,
} from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database, type Tx } from '../db/database.js';
import { memberships, projects, tenantMembers, users } from '../db/schema.js';

/** A person has at most one role per project; null takes them out of it. */
const PeopleBody = z.object({ role: Role.nullable() });

/**
 * The people of one project and their roles in it. Administrators (`users.manage`) change any
 * role up to their own rank; the project's manager (`projects.update` on it) gives roles from
 * supervisor down, to people who hold nothing above that in the organisation.
 */
@ApiTags('projects')
@Controller('projects/:projectId/people')
export class ProjectPeopleController {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  /** Roles this person may grant in the project (empty: they only look). */
  private grantable(ctx: AuthContext, projectId: string): Role[] {
    if (can(ctx.memberships, 'users.manage')) {
      const rank = tenantRank(ctx.memberships);
      return ROLES.filter((r) => r !== 'owner' && ROLE_RANK[r] <= rank);
    }
    if (can(ctx.memberships, 'projects.update', projectId))
      return ROLES.filter((r) => ROLE_RANK[r] <= ROLE_RANK.supervisor);
    return [];
  }

  @Get()
  @RequirePermission(['users.read', 'projects.update'], { projectParam: 'projectId' })
  list(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.project(tx, projectId);
      const people = await tx
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          status: tenantMembers.status,
        })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(ne(tenantMembers.status, 'deactivated'))
        .orderBy(asc(users.name));
      const grants = await tx.select().from(memberships);
      const members = people
        .map((p) => {
          const mine = grants.filter((g) => g.userId === p.id);
          return {
            userId: p.id,
            name: p.name,
            email: p.email,
            status: p.status,
            role: (mine.find((g) => g.projectId === projectId)?.role ?? null) as Role | null,
            orgRole: (mine.find((g) => g.projectId === null)?.role ?? null) as Role | null,
          };
        })
        .filter((m) => m.role);
      const grantable = this.grantable(ctx, projectId);
      return {
        members,
        candidates: people.map(({ id, name, email }) => ({ id, name, email })),
        grantable,
        canManage: grantable.length > 0,
      };
    });
  }

  @Put(':userId')
  @RequirePermission(['users.manage', 'projects.update'], { projectParam: 'projectId' })
  @ApiBody({ schema: z.toJSONSchema(PeopleBody) as object })
  set(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodPipe(PeopleBody)) body: z.infer<typeof PeopleBody>,
  ) {
    if (userId === ctx.userId) throw new ForbiddenException('You cannot change your own roles');
    const grantable = this.grantable(ctx, projectId);
    const { role } = body;
    if (role && !grantable.includes(role))
      throw new ForbiddenException(`You cannot grant the ${role} role`);
    const admin = can(ctx.memberships, 'users.manage');
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.project(tx, projectId);
      const [member] = await tx
        .select({ id: tenantMembers.id })
        .from(tenantMembers)
        .where(eq(tenantMembers.userId, userId));
      if (!member) throw new NotFoundException('User not found');
      const all = await tx.select().from(memberships).where(eq(memberships.userId, userId));
      const held = all.map((g) => ({ role: g.role as Role, projectId: g.projectId }));
      // Nobody acts on someone who outranks them; a project manager only on people at most
      // supervisor in the organisation.
      const ceiling = admin ? tenantRank(ctx.memberships) : ROLE_RANK.supervisor;
      if (
        tenantRank(held) > ceiling ||
        (held.some((g) => g.role === 'owner') && tenantRank(ctx.memberships) < ROLE_RANK.owner)
      )
        throw new ForbiddenException('You cannot manage this user');
      const before = held.find((g) => g.projectId === projectId)?.role ?? null;
      // Nor take away a role in the project they could not have given.
      if (before && !grantable.includes(before))
        throw new ForbiddenException('You cannot manage this user');
      await tx
        .delete(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.projectId, projectId)));
      if (role)
        await tx.insert(memberships).values({ tenantId: ctx.tenantId, userId, role, projectId });
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'user.role_changed',
          targetType: 'user',
          targetId: userId,
          details: { projectId, before, after: role },
        }),
      );
      return { userId, projectId, role };
    });
  }

  private async project(tx: Tx, projectId: string) {
    const [p] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!p) throw new NotFoundException('Project not found');
  }
}
