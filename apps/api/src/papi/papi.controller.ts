import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { PAPI_REPO, type PapiRepo } from './papi-repo.js';
import { FormsQuery, PapiService, ResolveBody } from './papi.service.js';

const PERM = { projectParam: 'projectId' } as const;

const LookupQuery = z.object({ externalId: z.string().min(1).max(200) });
const MismatchQuery = z.object({ status: z.enum(['open', 'resolved', 'all']).default('open') });

/** Paper forms: printing, keying by clerks, double-entry differences. */
@ApiTags('papi')
@Controller('projects/:projectId/papi')
export class PapiController {
  constructor(
    @Inject(PAPI_REPO) private readonly repo: PapiRepo,
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
    return this.repo.inTenant(ctx.tenantId, (t) => this.papi.forms(t, ctx, projectId, q));
  }

  /** Finds the case of a form by its id, and which entry is next. */
  @Get('lookup')
  @RequirePermission(['dataentry.key', 'interviews.conduct'], PERM)
  lookup(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(LookupQuery)) q: z.infer<typeof LookupQuery>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) =>
      this.papi.lookup(t, ctx, projectId, q.externalId),
    );
  }

  @Get('mismatches')
  @RequirePermission('interviews.review', PERM)
  mismatches(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(MismatchQuery)) q: z.infer<typeof MismatchQuery>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.papi.mismatches(t, projectId, q.status));
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
    return this.repo.inTenant(ctx.tenantId, (t) =>
      this.papi.resolve(t, ctx, projectId, id, body.choice),
    );
  }
}
