import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { ORG_REPO, type OrgRepo } from '../projects/org-repo.js';
import { CONFIG, type AppConfig } from '../config.js';
import { BI_MAX_MINUTES, BI_MINUTES_KEY, BI_MIN_MINUTES, BiService } from '../stats/bi.service.js';
import { AppSettingsService } from './app-settings.service.js';

/** `null`: the deployment's schedule applies again; `0`: never; otherwise minutes between refreshes. */
const BiBody = z
  .object({
    refreshMinutes: z.union([
      z.null(),
      z.literal(0),
      z.number().int().min(BI_MIN_MINUTES).max(BI_MAX_MINUTES),
    ]),
  })
  .strict();

/**
 * Settings of the installation as a whole. The analysis model (schema `bi`) spans every
 * organisation, so how often it is refreshed is not an organisation's own: whoever manages an
 * organisation sets it for the installation, and the audit log of theirs records it.
 */
@ApiTags('app-settings')
@Controller('app-settings')
export class AppSettingsController {
  constructor(
    @Inject(ORG_REPO) private readonly repo: OrgRepo,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly settings: AppSettingsService,
    private readonly bi: BiService,
    private readonly audit: AuditService,
  ) {}

  @Get('bi')
  @RequirePermission('tenant.read')
  async get() {
    const minutes = await this.bi.minutes();
    return {
      /** `null`: not set, the deployment's cron applies; `0`: never. */
      refreshMinutes: minutes === undefined ? null : (minutes ?? 0),
      source: minutes === undefined ? 'deployment' : 'setting',
      deploymentCron: this.config.BI_REFRESH_CRON,
      lastRunAt: (await this.bi.lastRun())?.toISOString() ?? null,
      min: BI_MIN_MINUTES,
      max: BI_MAX_MINUTES,
    };
  }

  @Post('bi')
  @HttpCode(200)
  @RequirePermission('tenant.manage')
  @ApiBody({ schema: z.toJSONSchema(BiBody) as object })
  async set(@Auth() ctx: AuthContext, @Body(new ZodPipe(BiBody)) body: z.infer<typeof BiBody>) {
    await this.settings.set(
      BI_MINUTES_KEY,
      body.refreshMinutes === null ? null : String(body.refreshMinutes),
      ctx.userId,
    );
    await this.repo.inTenant(ctx.tenantId, (t) =>
      t.audit(
        this.audit.fromContext(ctx, {
          action: 'app.bi_frequency_changed',
          targetType: 'app_setting',
          targetId: BI_MINUTES_KEY,
          details: body,
        }),
      ),
    );
    return this.get();
  }

  /** Refreshes the model now, whatever the frequency; returns whether anything had changed. */
  @Post('bi/refresh')
  @HttpCode(200)
  @RequirePermission('tenant.manage')
  async refresh() {
    return { ran: await this.bi.refresh(false) };
  }
}
