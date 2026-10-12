import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { FormsQuery, PapiService, ResolveBody } from './papi.service.js';

const PERM = { projectParam: 'projectId' } as const;

const LookupQuery = z.object({ externalId: z.string().min(1).max(200) });
const MismatchQuery = z.object({ status: z.enum(['open', 'resolved', 'all']).default('open') });

/** Paper forms: printing, keying by clerks, double-entry differences. */
@ApiTags('papi')
@Controller('projects/:projectId/papi')
export class PapiController {
  constructor(
    private readonly database: Database,
    private readonly papi: PapiService,
  ) {}

  /** The questionnaire and case covers to print. */
  @Get('forms')
  @RequirePermission(['cases.read_all', 'cases.read_assigned'], PERM)
  forms(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(FormsQuery)) q: z.infer<typeof FormsQuery>,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.papi.forms(tx, ctx, projectId, q));
  }

  /** Finds the case of a form by its id, and which entry is next. */
  @Get('lookup')
  @RequirePermission(['dataentry.key', 'interviews.conduct'], PERM)
  lookup(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(LookupQuery)) q: z.infer<typeof LookupQuery>,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.papi.lookup(tx, ctx, projectId, q.externalId),
    );
  }

  @Get('mismatches')
  @RequirePermission('interviews.review', PERM)
  mismatches(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(MismatchQuery)) q: z.infer<typeof MismatchQuery>,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.papi.mismatches(tx, projectId, q.status),
    );
  }

  @Post('mismatches/:id/resolve')
  @HttpCode(200)
  @RequirePermission('interviews.review', PERM)
  @ApiBody({ schema: z.toJSONSchema(ResolveBody) as object })
  resolve(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ResolveBody)) body: z.infer<typeof ResolveBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.papi.resolve(tx, ctx, projectId, id, body.choice),
    );
  }
}
