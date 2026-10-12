import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CasesService } from '../cases/cases.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Database } from '../db/database.js';
import { cases, contacts } from '../db/schema.js';
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
    private readonly database: Database,
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
    await this.database.withTenant(ctx.tenantId, (tx) => this.cases.project(tx, projectId));
    const todo = await this.geo.pending(
      ctx.tenantId,
      projectId,
      this.config.GEOCODE_MAX,
      body.again,
    );
    await this.database.withTenant(ctx.tenantId, (tx) =>
      this.audit.record(
        tx,
        ctx.tenantId,
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
   * address stays behind the audited reveal in the case drawer.
   */
  @Get('cases-map')
  @RequirePermission(['cases.read_all', 'cases.read_assigned'], PERM)
  map(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.cases.project(tx, projectId);
      const own = this.cases.restrictedToOwn(ctx, projectId);
      return tx
        .select({
          caseId: cases.id,
          externalId: cases.externalId,
          status: cases.status,
          lat: contacts.lat,
          lng: contacts.lng,
          quality: contacts.geocodeQuality,
        })
        .from(contacts)
        .innerJoin(cases, eq(cases.id, contacts.caseId))
        .where(
          and(
            eq(cases.projectId, projectId),
            eq(contacts.type, 'address'),
            isNotNull(contacts.lat),
            ...(own ? [eq(cases.assignedTo, ctx.userId)] : []),
          ),
        )
        .limit(20_000);
    });
  }
}
