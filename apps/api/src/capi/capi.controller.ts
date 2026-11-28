import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  AfterClose,
  FieldWork,
  Auth,
  RequirePermission,
  type AuthContext,
} from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { INTERVIEWS_REPO, type InterviewsRepo } from '../interviews/interviews-repo.js';
import { CapiService, CheckinBody, CheckoutBody } from './capi.service.js';

const PERM = { projectParam: 'projectId' } as const;

/** Devices for face-to-face interviewing: download cases, give them back. */
@ApiTags('capi')
@Controller()
export class CapiController {
  constructor(
    @Inject(INTERVIEWS_REPO) private readonly repo: InterviewsRepo,
    private readonly capi: CapiService,
  ) {}

  /** Downloads cases to this device for offline work. Cases that cannot be taken are listed. */
  @Post('projects/:projectId/capi/checkout')
  @FieldWork()
  @HttpCode(200)
  @RequirePermission('interviews.conduct', PERM)
  @ApiBody({ schema: z.toJSONSchema(CheckoutBody) as object })
  checkout(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(CheckoutBody)) body: CheckoutBody,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.capi.checkout(t, ctx, projectId, body));
  }

  /** Gives cases back from this device. */
  @Post('projects/:projectId/capi/checkin')
  @AfterClose()
  @HttpCode(200)
  @RequirePermission('interviews.conduct', PERM)
  @ApiBody({ schema: z.toJSONSchema(CheckinBody) as object })
  checkin(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(CheckinBody)) body: z.infer<typeof CheckinBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) =>
      this.capi.checkin(t, ctx, projectId, body.deviceId, body.caseIds),
    );
  }

  /** Cases on devices and the last synchronisation, per interviewer (those who follow the team). */
  @Get('projects/:projectId/capi/devices')
  @RequirePermission('metrics.team', PERM)
  devices(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.capi.devices(t, projectId));
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
    return this.repo.inTenant(ctx.tenantId, (t) =>
      this.capi.forceRelease(t, ctx, projectId, caseId),
    );
  }
}
