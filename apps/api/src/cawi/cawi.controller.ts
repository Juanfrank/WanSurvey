import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { CAWI_REPO, type CawiRepo } from './cawi-repo.js';
import { CawiService, OpenLinkBody, TemplateBody, WaveBody } from './cawi.service.js';

const PERM = { projectParam: 'projectId' } as const;
const TEMPLATES = ['email.templates', 'cawi.waves'] as const;

/** Web surveys for project staff: e-mail wording, waves and their funnel, the open link. */
@ApiTags('cawi')
@Controller('projects/:projectId')
export class CawiController {
  constructor(
    @Inject(CAWI_REPO) private readonly repo: CawiRepo,
    private readonly cawi: CawiService,
  ) {}

  @Get('email-templates')
  @RequirePermission(TEMPLATES, PERM)
  templates(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cawi.templates(t, projectId));
  }

  @Put('email-templates')
  @RequirePermission(TEMPLATES, PERM)
  @ApiBody({ schema: z.toJSONSchema(TemplateBody) as object })
  saveTemplate(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(TemplateBody)) body: z.infer<typeof TemplateBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cawi.saveTemplate(t, ctx, projectId, body));
  }

  @Get('waves')
  @RequirePermission('cawi.waves', PERM)
  waves(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cawi.listWaves(t, projectId));
  }

  @Post('waves')
  @RequirePermission('cawi.waves', PERM)
  @ApiBody({ schema: z.toJSONSchema(WaveBody, { io: 'input' }) as object })
  createWave(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(WaveBody)) body: z.infer<typeof WaveBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cawi.createWave(t, ctx, projectId, body));
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
    return this.repo.inTenant(ctx.tenantId, (t) => this.cawi.sendWave(t, ctx, projectId, waveId));
  }

  /** The personal links of a "links only" wave (W7). */
  @Get('waves/:waveId/links')
  @RequirePermission('cawi.waves', PERM)
  links(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('waveId', ParseUUIDPipe) waveId: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cawi.waveLinks(t, projectId, waveId));
  }

  @Get('suppressions')
  @RequirePermission('cawi.waves', PERM)
  suppressions(@Auth() ctx: AuthContext) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cawi.suppressionList(t));
  }

  @Get('open-link')
  @RequirePermission('cawi.waves', PERM)
  openLink(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.repo.inTenant(ctx.tenantId, async (t) => ({
      link: await this.cawi.openLink(t, projectId),
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
    return this.repo.inTenant(ctx.tenantId, async (t) => ({
      link: await this.cawi.setOpenLink(t, projectId, body),
    }));
  }
}
