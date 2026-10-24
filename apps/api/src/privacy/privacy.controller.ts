import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, can, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { PrivacyService } from './privacy.service.js';

const PERM = { projectParam: 'projectId' } as const;
const EraseBody = z.object({
  /** Why: the request reference, kept in the audit log. */
  note: z.string().trim().min(3).max(500),
});

/** A data subject's requests: see what is held about them, or have it erased (H3). */
@ApiTags('privacy')
@Controller('projects/:projectId/cases/:caseId')
export class PrivacyController {
  constructor(
    private readonly database: Database,
    private readonly privacy: PrivacyService,
  ) {}

  @Get('subject-data')
  @RequirePermission('pii.view', PERM)
  subjectData(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    if (!can(ctx.memberships, 'cases.read_all', projectId))
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You may not do this' });
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.privacy.subjectData(tx, ctx, projectId, caseId),
    );
  }

  @Post('erase')
  @HttpCode(200)
  @RequirePermission('cases.edit', PERM)
  @ApiBody({ schema: z.toJSONSchema(EraseBody) as object })
  async erase(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body(new ZodPipe(EraseBody)) body: z.infer<typeof EraseBody>,
  ) {
    if (!can(ctx.memberships, 'pii.view', projectId))
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You may not do this' });
    const out = await this.database.withTenant(ctx.tenantId, (tx) =>
      this.privacy.anonymise(tx, ctx.tenantId, ctx, projectId, caseId, 'request', body.note),
    );
    await this.privacy.refreshAnalysis();
    return out;
  }
}
