import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { CawiService, OpenLinkBody, TemplateBody, WaveBody } from './cawi.service.js';

const PERM = { projectParam: 'projectId' } as const;
const TEMPLATES = ['email.templates', 'cawi.waves'] as const;

/** Web surveys for project staff: e-mail wording, waves and their funnel, the open link. */
@ApiTags('cawi')
@Controller('projects/:projectId')
export class CawiController {
  constructor(
    private readonly database: Database,
    private readonly cawi: CawiService,
  ) {}

  @Get('email-templates')
  @RequirePermission(TEMPLATES, PERM)
  templates(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.cawi.templates(tx, projectId));
  }

  @Put('email-templates')
  @RequirePermission(TEMPLATES, PERM)
  @ApiBody({ schema: z.toJSONSchema(TemplateBody) as object })
  saveTemplate(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(TemplateBody)) body: z.infer<typeof TemplateBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.cawi.saveTemplate(tx, ctx, projectId, body),
    );
  }

  @Get('waves')
  @RequirePermission('cawi.waves', PERM)
  waves(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.cawi.listWaves(tx, projectId));
  }

  @Post('waves')
  @RequirePermission('cawi.waves', PERM)
  @ApiBody({ schema: z.toJSONSchema(WaveBody, { io: 'input' }) as object })
  createWave(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(WaveBody)) body: z.infer<typeof WaveBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.cawi.createWave(tx, ctx, projectId, body),
    );
  }

  /** Queues the wave's invitations; the dispatcher sends them. */
  @Post('waves/:waveId/send')
  @HttpCode(200)
  @RequirePermission('cawi.waves', PERM)
  send(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('waveId', ParseUUIDPipe) waveId: string,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.cawi.sendWave(tx, ctx, projectId, waveId),
    );
  }

  @Get('suppressions')
  @RequirePermission('cawi.waves', PERM)
  suppressions(@Auth() ctx: AuthContext) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.cawi.suppressionList(tx));
  }

  @Get('open-link')
  @RequirePermission('cawi.waves', PERM)
  openLink(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => ({
      link: await this.cawi.openLink(tx, projectId),
    }));
  }

  @Put('open-link')
  @RequirePermission('cawi.waves', PERM)
  @ApiBody({ schema: z.toJSONSchema(OpenLinkBody) as object })
  setOpenLink(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(OpenLinkBody)) body: z.infer<typeof OpenLinkBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => ({
      link: await this.cawi.setOpenLink(tx, ctx, projectId, body),
    }));
  }
}
