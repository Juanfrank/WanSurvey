import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CasesService } from '../cases/cases.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { CONFIG, type AppConfig } from '../config.js';
import { CASES_REPO, type CasesRepo } from '../cases/cases-repo.js';
import { GeoService } from './geo.service.js';

const PERM = { projectParam: 'projectId' } as const;
const GeocodeBody = z.object({
  /** Also geocode addresses done before (after the addresses were corrected). */
  again: z.boolean().default(false),
});

/** Geocoding of case addresses and the points for the case map. */
@ApiTags('cases')
@Controller('projects/:projectId')
export class GeoController {
  constructor(
    @Inject(CASES_REPO) private readonly repo: CasesRepo,
    private readonly audit: AuditService,
    private readonly geo: GeoService,
    private readonly cases: CasesService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Starts geocoding the project's addresses in the background. */
  @Post('geocode')
  @HttpCode(202)
  @RequirePermission('cases.edit', PERM)
  @ApiBody({ schema: z.toJSONSchema(GeocodeBody, { io: 'input' }) as object })
  async geocode(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(GeocodeBody)) body: z.infer<typeof GeocodeBody>,
  ) {
    if (!this.geo.geocoder)
      throw new BadRequestException({
        code: 'GEOCODER_OFF',
        message: 'Geocoding is not set up on this server (GEOCODER)',
      });
    if (this.geo.status(projectId)?.running)
      throw new ConflictException({
        code: 'GEOCODE_RUNNING',
        message: 'Addresses of this project are being geocoded already',
      });
    await this.repo.inTenant(ctx.tenantId, (t) => this.cases.project(t, projectId));
    const todo = await this.geo.pending(
      ctx.tenantId,
      projectId,
      this.config.GEOCODE_MAX,
      body.again,
    );
    await this.repo.inTenant(ctx.tenantId, (t) =>
      t.audit(
        this.audit.fromContext(ctx, {
          action: 'cases.geocoded',
          targetType: 'project',
          targetId: projectId,
          // Addresses leave the platform: record that, and to which service.
          details: { addresses: todo.length, service: this.geo.geocoder!.name },
        }),
      ),
    );
    return this.geo.start(ctx.tenantId, projectId, todo);
  }

  @Get('geocode/status')
  @RequirePermission(['cases.read_all', 'cases.edit'], PERM)
  status(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return { enabled: !!this.geo.geocoder, job: this.geo.status(projectId) };
  }

  /**
   * Geocoded points of the cases the caller may see. Points carry no address or name: the
   * address stays behind the audited reveal in the case drawer. Coordinates locate the person
   * as well as the address does, so they go only to people allowed to see personal data, and
   * each view is audited.
   */
  @Get('cases-map')
  @RequirePermission(['cases.read_all', 'cases.read_assigned'], PERM)
  map(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.cases.project(t, projectId);
      if (!this.cases.canSeePii(ctx, projectId))
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'You may not see personal data',
        });
      const own = this.cases.restrictedToOwn(ctx, projectId);
      const points = await t.mapPoints(projectId, own ? ctx.userId : undefined);
      if (points.length)
        await t.audit(
          this.audit.fromContext(ctx, {
            action: 'cases.map_viewed',
            targetType: 'project',
            targetId: projectId,
            details: { points: points.length },
          }),
        );
      return points;
    });
  }
}
