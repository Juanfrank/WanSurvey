import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { CapiService, CheckinBody, CheckoutBody } from './capi.service.js';

const PERM = { projectParam: 'projectId' } as const;

/** Devices for face-to-face interviewing: download cases, give them back. */
@ApiTags('capi')
@Controller()
export class CapiController {
  constructor(
    private readonly database: Database,
    private readonly capi: CapiService,
  ) {}

  /** Downloads cases to this device for offline work. Cases that cannot be taken are listed. */
  @Post('projects/:projectId/capi/checkout')
  @HttpCode(200)
  @RequirePermission('interviews.conduct', PERM)
  @ApiBody({ schema: z.toJSONSchema(CheckoutBody) as object })
  checkout(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(CheckoutBody)) body: CheckoutBody,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.capi.checkout(tx, ctx, projectId, body),
    );
  }

  /** Gives cases back from this device. */
  @Post('projects/:projectId/capi/checkin')
  @HttpCode(200)
  @RequirePermission('interviews.conduct', PERM)
  @ApiBody({ schema: z.toJSONSchema(CheckinBody) as object })
  checkin(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(CheckinBody)) body: z.infer<typeof CheckinBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.capi.checkin(tx, ctx, projectId, body.deviceId, body.caseIds),
    );
  }

  /** Frees a case from a device that is lost or broken (supervisors). */
  @Post('projects/:projectId/cases/:caseId/force-release')
  @HttpCode(200)
  @RequirePermission('cases.assign', PERM)
  forceRelease(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.capi.forceRelease(tx, ctx, projectId, caseId),
    );
  }
}
