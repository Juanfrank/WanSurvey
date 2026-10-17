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
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database, type Tx } from '../db/database.js';
import { teamMembers, teams, tenantMembers, users } from '../db/schema.js';

const TeamBody = z.object({
  name: z.string().trim().min(1).max(100),
  leaderId: z.uuid().nullable().default(null),
  memberIds: z.array(z.uuid()).max(1000).default([]),
});
const TeamPatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  leaderId: z.uuid().nullable().optional(),
  memberIds: z.array(z.uuid()).max(1000).optional(),
});

/**
 * Teams of the organisation (a field crew, a call-centre shift): a name, a leader and members,
 * all people of the organisation. Seen by whoever sees the people (`users.read`); changed by
 * whoever manages them (`users.manage`).
 */
@ApiTags('teams')
@Controller('teams')
export class TeamsController {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('users.read')
  list(@Auth() ctx: AuthContext) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.select().from(teams).orderBy(asc(teams.name));
      const members = rows.length
        ? await tx
            .select({
              teamId: teamMembers.teamId,
              userId: users.id,
              name: users.name,
              email: users.email,
            })
            .from(teamMembers)
            .innerJoin(users, eq(users.id, teamMembers.userId))
            .where(
              inArray(
                teamMembers.teamId,
                rows.map((r) => r.id),
              ),
            )
            .orderBy(asc(users.name))
        : [];
      return rows.map((r) => {
        const ms = members.filter((m) => m.teamId === r.id);
        const leader = r.leaderUserId
          ? (ms.find((m) => m.userId === r.leaderUserId) ?? null)
          : null;
        return {
          id: r.id,
          name: r.name,
          leaderId: r.leaderUserId,
          leaderName: leader?.name ?? null,
          members: ms.map(({ teamId: _t, ...m }) => m),
        };
      });
    });
  }

  /** People must belong to the organisation; the leader is also a member. */
  private async checkPeople(tx: Tx, ids: string[]) {
    if (!ids.length) return;
    const found = await tx
      .select({ userId: tenantMembers.userId })
      .from(tenantMembers)
      .where(inArray(tenantMembers.userId, ids));
    if (found.length !== new Set(ids).size)
      throw new BadRequestException({
        code: 'NOT_A_MEMBER',
        message: 'Teams are made of people of this organisation',
      });
  }

  private async setMembers(tx: Tx, tenantId: string, teamId: string, ids: string[]) {
    await tx.delete(teamMembers).where(eq(teamMembers.teamId, teamId));
    const unique = [...new Set(ids)];
    if (unique.length)
      await tx.insert(teamMembers).values(unique.map((userId) => ({ teamId, userId, tenantId })));
  }

  private async unique(tx: Tx, name: string, except?: string) {
    const [dup] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.name, name));
    if (dup && dup.id !== except)
      throw new ConflictException({ code: 'CONFLICT', message: 'A team with this name exists' });
  }

  @Post()
  @RequirePermission('users.manage')
  @ApiBody({ schema: z.toJSONSchema(TeamBody, { io: 'input' }) as object })
  create(@Auth() ctx: AuthContext, @Body(new ZodPipe(TeamBody)) body: z.infer<typeof TeamBody>) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const memberIds = [
        ...new Set([...body.memberIds, ...(body.leaderId ? [body.leaderId] : [])]),
      ];
      await this.checkPeople(tx, memberIds);
      await this.unique(tx, body.name);
      const [team] = await tx
        .insert(teams)
        .values({ tenantId: ctx.tenantId, name: body.name, leaderUserId: body.leaderId })
        .returning();
      await this.setMembers(tx, ctx.tenantId, team!.id, memberIds);
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'team.created',
          targetType: 'team',
          targetId: team!.id,
          details: { name: body.name, leaderId: body.leaderId, members: memberIds.length },
        }),
      );
      return { id: team!.id };
    });
  }

  @Patch(':id')
  @RequirePermission('users.manage')
  @ApiBody({ schema: z.toJSONSchema(TeamPatch) as object })
  update(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(TeamPatch)) body: z.infer<typeof TeamPatch>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [team] = await tx.select().from(teams).where(eq(teams.id, id));
      if (!team) throw new NotFoundException('Team not found');
      if (body.name) await this.unique(tx, body.name, id);
      const leaderId = body.leaderId !== undefined ? body.leaderId : team.leaderUserId;
      if (body.memberIds || body.leaderId) {
        const current = body.memberIds
          ? body.memberIds
          : (
              await tx
                .select({ userId: teamMembers.userId })
                .from(teamMembers)
                .where(eq(teamMembers.teamId, id))
            ).map((m) => m.userId);
        const memberIds = [...new Set([...current, ...(leaderId ? [leaderId] : [])])];
        await this.checkPeople(tx, memberIds);
        await this.setMembers(tx, ctx.tenantId, id, memberIds);
      }
      await tx
        .update(teams)
        .set({ ...(body.name ? { name: body.name } : {}), leaderUserId: leaderId })
        .where(and(eq(teams.id, id)));
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'team.updated',
          targetType: 'team',
          targetId: id,
          details: { ...body, memberIds: body.memberIds?.length },
        }),
      );
      return { ok: true };
    });
  }

  @Delete(':id')
  @RequirePermission('users.manage')
  remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const r = await tx.delete(teams).where(eq(teams.id, id)).returning({ name: teams.name });
      if (!r.length) throw new NotFoundException('Team not found');
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'team.deleted',
          targetType: 'team',
          targetId: id,
          details: { name: r[0]!.name },
        }),
      );
      return { ok: true };
    });
  }
}
