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
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { TEAMS_REPO, type TeamsRepo, type TeamsTx } from './teams-repo.js';

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
/**
 * Teams of the organisation (a field crew, a call-centre shift): a name, a leader and members,
 * all people of the organisation. Seen by whoever sees the people (`users.read`); changed by
 * whoever manages them (`users.manage`).
 */
@ApiTags('teams')
@Controller('teams')
export class TeamsController {
  constructor(
    @Inject(TEAMS_REPO) private readonly repo: TeamsRepo,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('users.read')
  list(@Auth() ctx: AuthContext) {
    return this.repo.inTenant(ctx.tenantId, (t) => t.list());
  }

  /** People must belong to the organisation; the leader is also a member. */
  private async checkPeople(t: TeamsTx, ids: string[]) {
    if (!ids.length) return;
    if ((await t.strangers(ids)).length)
      throw new BadRequestException({
        code: 'NOT_A_MEMBER',
        message: 'Teams are made of people of this organisation',
      });
  }

  private async unique(t: TeamsTx, name: string, except?: string) {
    if (await t.nameTaken(name, except))
      throw new ConflictException({ code: 'CONFLICT', message: 'A team with this name exists' });
  }

  @Post()
  @RequirePermission('users.manage')
  @ApiBody({ schema: z.toJSONSchema(TeamBody, { io: 'input' }) as object })
  create(@Auth() ctx: AuthContext, @Body(new ZodPipe(TeamBody)) body: z.infer<typeof TeamBody>) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const memberIds = [
        ...new Set([...body.memberIds, ...(body.leaderId ? [body.leaderId] : [])]),
      ];
      await this.checkPeople(t, memberIds);
      await this.unique(t, body.name);
      const id = await t.create({ name: body.name, leaderId: body.leaderId, memberIds });
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'team.created',
          targetType: 'team',
          targetId: id,
          details: { name: body.name, leaderId: body.leaderId, members: memberIds.length },
        }),
      );
      return { id };
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const team = await t.current(id);
      if (!team) throw new NotFoundException('Team not found');
      if (body.name) await this.unique(t, body.name, id);
      const leaderId = body.leaderId !== undefined ? body.leaderId : team.leaderId;
      let memberIds: string[] | undefined;
      if (body.memberIds || body.leaderId) {
        const current = body.memberIds ?? team.memberIds;
        memberIds = [...new Set([...current, ...(leaderId ? [leaderId] : [])])];
        await this.checkPeople(t, memberIds);
      }
      await t.update(id, { name: body.name, leaderId, memberIds });
      await t.audit(
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const name = await t.remove(id);
      if (name === null) throw new NotFoundException('Team not found');
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'team.deleted',
          targetType: 'team',
          targetId: id,
          details: { name },
        }),
      );
      return { ok: true };
    });
  }
}
