import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { ROLE_RANK, ROLES, Role } from '@wansurvey/schema';
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
import { USERS_REPO, type UsersRepo } from '../users/users-repo.js';
import { ORG_REPO, type OrgRepo } from './org-repo.js';

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
    @Inject(USERS_REPO) private readonly repo: UsersRepo,
    @Inject(ORG_REPO) private readonly org: OrgRepo,
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.project(projectId, ctx);
      const people = (await t.members()).filter((m) => m.status !== 'deactivated');
      const grants = await t.grants();
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.project(projectId, ctx);
      if (!(await t.isMember(userId))) throw new NotFoundException('User not found');
      const all = await t.grants(userId);
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
      await t.setProjectRole(userId, projectId, role);
      await t.audit(
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

  private async project(projectId: string, ctx: AuthContext) {
    const p = await this.org.inTenant(ctx.tenantId, (o) => o.project(projectId));
    if (!p) throw new NotFoundException('Project not found');
  }
}
