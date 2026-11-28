import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { CAWI_REPO, type CawiRepo } from './cawi-repo.js';
import {
  CawiService,
  LinkExpiryBody,
  OpenLinkBody,
  PrefilledLinkBody,
  TemplateBody,
  WaveBody,
} from './cawi.service.js';

const PERM = { projectParam: 'projectId' } as const;
const TEMPLATES = ['email.templates', 'cawi.waves'] as const;

/** Why the links are fetched: shown on screen or downloaded as a file (both logged). */
const LinksQuery = z.object({ for: z.enum(['view', 'download']).default('view') });

const SendBody = z.object({ confirm: z.boolean().default(false) }).default({ confirm: false });

/** Web surveys for project staff: e-mail wording, waves and their funnel, the open link. */
@ApiTags('cawi')
@Controller('projects/:projectId')
export class CawiController {
  constructor(
    @Inject(CAWI_REPO) private readonly repo: CawiRepo,
    private readonly cawi: CawiService,
    private readonly audit: AuditService,
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
    @Body(new ZodPipe(SendBody)) body: z.infer<typeof SendBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) =>
      this.cawi.sendWave(t, ctx, projectId, waveId, body.confirm),
    );
  }

  /** For an SMS wave: who it would write to, how many messages and what that costs. */
  @Get('waves/:waveId/preview')
  @RequirePermission('cawi.waves', PERM)
  preview(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('waveId', ParseUUIDPipe) waveId: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cawi.previewSmsWave(t, projectId, waveId));
  }

  /**
   * The personal links of a "links only" wave (W7). Each link opens a person's survey, with
   * their data: like a password, every time they are shown or downloaded is logged.
   */
  @Get('waves/:waveId/links')
  @RequirePermission('cawi.waves', PERM)
  links(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('waveId', ParseUUIDPipe) waveId: string,
    @Query(new ZodPipe(LinksQuery)) query: z.infer<typeof LinksQuery>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const links = await this.cawi.waveLinks(t, projectId, waveId);
      if (links.length)
        await t.audit(
          this.audit.fromContext(ctx, {
            action: query.for === 'download' ? 'cawi.links_downloaded' : 'cawi.links_viewed',
            targetType: 'wave',
            targetId: waveId,
            details: { projectId, links: links.length },
          }),
        );
      return links;
    });
  }

  /** A personal link's own end date (null: none), logged. */
  @Patch('waves/:waveId/links/:linkId')
  @RequirePermission('cawi.waves', PERM)
  @ApiBody({ schema: z.toJSONSchema(LinkExpiryBody) as object })
  setLinkExpiry(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('waveId', ParseUUIDPipe) waveId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Body(new ZodPipe(LinkExpiryBody)) body: z.infer<typeof LinkExpiryBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.cawi.setLinkExpiry(t, projectId, waveId, linkId, body.expiresAt);
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'cawi.link_expiry_set',
          targetType: 'invitation',
          targetId: linkId,
          details: { projectId, waveId, expiresAt: body.expiresAt },
        }),
      );
      return { ok: true };
    });
  }

  /** Withdraws a personal link: it no longer opens the survey. Logged. */
  @Post('waves/:waveId/links/:linkId/revoke')
  @HttpCode(200)
  @RequirePermission('cawi.waves', PERM)
  revokeLink(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('waveId', ParseUUIDPipe) waveId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.cawi.revokeLink(t, ctx, projectId, waveId, linkId);
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'cawi.link_revoked',
          targetType: 'invitation',
          targetId: linkId,
          details: { projectId, waveId },
        }),
      );
      return { ok: true };
    });
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

  /**
   * For an outside system or a person: the answers already known, as plain values, give back
   * a short link that starts the survey with them (confirmed, collected or only kept, as each
   * question's prefill mode says).
   */
  @Post('open-link/prefilled')
  @RequirePermission('cawi.waves', PERM)
  @ApiBody({ schema: z.toJSONSchema(PrefilledLinkBody) as object })
  prefilledLink(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(PrefilledLinkBody)) body: z.infer<typeof PrefilledLinkBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cawi.prefilledLink(t, projectId, body));
  }
}
