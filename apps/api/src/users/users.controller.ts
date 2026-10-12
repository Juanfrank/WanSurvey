import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { Role } from '@wansurvey/schema';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { UsersService } from './users.service.js';

const Grant = z.object({ role: Role, projectId: z.string().uuid().nullable().default(null) });
const InviteBody = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(200),
  firstName: z.string().max(100).optional(),
  idCode: z.string().max(50).optional(),
  languages: z.array(z.string().max(16)).max(20).optional(),
  memberships: z.array(Grant).min(1).max(50),
});
const MembershipsBody = z.object({ memberships: z.array(Grant).max(50) });

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('users.read')
  list(@Auth() ctx: AuthContext) {
    return this.users.list(ctx);
  }

  @Post('invite')
  @RequirePermission('users.manage')
  @ApiBody({ schema: z.toJSONSchema(InviteBody) as object })
  invite(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(InviteBody)) body: z.infer<typeof InviteBody>,
  ) {
    return this.users.invite(ctx, body);
  }

  @Put(':id/memberships')
  @RequirePermission('users.manage')
  @ApiBody({ schema: z.toJSONSchema(MembershipsBody) as object })
  setMemberships(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(MembershipsBody)) body: z.infer<typeof MembershipsBody>,
  ) {
    return this.users.setMemberships(ctx, id, body.memberships);
  }

  @Post(':id/deactivate')
  @HttpCode(204)
  @RequirePermission('users.manage')
  async deactivate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.users.deactivate(ctx, id);
  }

  @Post(':id/force-logout')
  @HttpCode(204)
  @RequirePermission('users.manage')
  async forceLogout(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.users.forceLogout(ctx, id);
  }
}
