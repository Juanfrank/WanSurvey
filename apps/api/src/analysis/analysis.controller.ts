import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
  StreamableFile,
  type MessageEvent,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Observable } from 'rxjs';
import { z } from 'zod';
import { Auth, Public, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { sha256Hex } from '../common/crypto.js';
import { ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { LiveService } from '../dashboard/live.service.js';
import { ExportBody, ExportsService } from '../exports/exports.service.js';
import { MetricsQuery, MetricsService } from '../metrics/metrics.service.js';
import { AnalysisQuery, AnalysisService, CrosstabQuery } from './analysis.service.js';
import { DatasetService } from './dataset.service.js';
import { ShareBody, ShareService } from './share.service.js';

const PERM = { projectParam: 'projectId' } as const;

/** Metrics, the live dashboard, toplines, the summary, exports and share links (slice 12). */
@ApiTags('analysis')
@Controller('projects/:projectId')
export class AnalysisController {
  constructor(
    private readonly database: Database,
    private readonly metrics: MetricsService,
    private readonly live: LiveService,
    private readonly analysis: AnalysisService,
    private readonly datasets: DatasetService,
    private readonly exportsService: ExportsService,
    private readonly share: ShareService,
  ) {}

  @Get('metrics/interviewers')
  @RequirePermission(['metrics.team', 'metrics.own'], PERM)
  interviewers(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(MetricsQuery)) q: z.infer<typeof MetricsQuery>,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.metrics.interviewers(tx, ctx, projectId, q),
    );
  }

  @Get('live/snapshot')
  @RequirePermission('dashboards.read', PERM)
  snapshot(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.live.snapshot(tx, projectId));
  }

  /** Server-Sent Events: `snapshot` on change, `heartbeat` every 15 s (M2). */
  @Sse('live')
  @RequirePermission('dashboards.read', PERM)
  stream(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Observable<MessageEvent> {
    return this.live.stream(ctx.tenantId, projectId);
  }

  @Get('data/questionnaires')
  @RequirePermission(['dashboards.read', 'exports.run'], PERM)
  questionnaires(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.datasets.questionnaires(tx, projectId),
    );
  }

  @Get('topline')
  @RequirePermission('dashboards.read', PERM)
  topline(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(AnalysisQuery)) q: z.infer<typeof AnalysisQuery>,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.analysis.topline(tx, projectId, q));
  }

  @Get('crosstab')
  @RequirePermission('dashboards.read', PERM)
  crosstab(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(CrosstabQuery)) q: z.infer<typeof CrosstabQuery>,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.analysis.crosstab(tx, projectId, q));
  }

  @Get('summary')
  @RequirePermission('dashboards.read', PERM)
  summary(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(AnalysisQuery)) q: z.infer<typeof AnalysisQuery>,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.analysis.summary(tx, projectId, q));
  }

  @Get('exports')
  @RequirePermission('exports.run', PERM)
  listExports(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.exportsService.list(tx, projectId));
  }

  @Post('exports')
  @RequirePermission('exports.run', PERM)
  @ApiBody({ schema: z.toJSONSchema(ExportBody, { io: 'input' }) as object })
  async requestExport(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(ExportBody)) body: z.infer<typeof ExportBody>,
  ) {
    const row = await this.database.withTenant(ctx.tenantId, (tx) =>
      this.exportsService.request(tx, ctx, projectId, body),
    );
    // Queued once the row is committed, so the worker always finds it.
    await this.exportsService.queue(ctx.tenantId, row.id);
    return row;
  }

  @Get('exports/:id/file')
  @RequirePermission('exports.run', PERM)
  async download(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const f = await this.database.withTenant(ctx.tenantId, (tx) =>
      this.exportsService.file(tx, ctx, projectId, id),
    );
    return new StreamableFile(f.file, {
      type: f.contentType,
      disposition: `attachment; filename="${f.fileName}"`,
      length: f.file.length,
    });
  }

  @Get('share-links')
  @RequirePermission('projects.update', PERM)
  links(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.share.list(tx, projectId));
  }

  @Post('share-links')
  @RequirePermission('projects.update', PERM)
  @ApiBody({ schema: z.toJSONSchema(ShareBody, { io: 'input' }) as object })
  createLink(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(ShareBody)) body: z.infer<typeof ShareBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.share.create(tx, ctx, projectId, body),
    );
  }

  @Post('share-links/:id/revoke')
  @HttpCode(204)
  @RequirePermission('projects.update', PERM)
  async revokeLink(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.database.withTenant(ctx.tenantId, (tx) => this.share.revoke(tx, ctx, projectId, id));
  }
}

const Token = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/);

/** A client's read-only summary through a share link (M7): no account, nothing else. */
@ApiTags('analysis')
@Controller('public/share')
export class PublicShareController {
  constructor(
    private readonly database: Database,
    private readonly analysis: AnalysisService,
    private readonly share: ShareService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':token')
  async summary(
    @Param('token') token: string,
    @Query(new ZodPipe(AnalysisQuery.pick({ mode: true, lang: true })))
    q: z.infer<typeof AnalysisQuery>,
  ) {
    if (!Token.safeParse(token).success) throw new NotFoundException('Link not found');
    const link = await this.database.shareLinkByHash(sha256Hex(token));
    if (!link)
      throw new NotFoundException({ code: 'LINK_EXPIRED', message: 'This link is not valid' });
    return this.database.withTenant(link.tenantId, async (tx) => {
      const projectId = await this.share.projectOf(tx, link.id);
      return this.analysis.summary(tx, projectId, q);
    });
  }
}
