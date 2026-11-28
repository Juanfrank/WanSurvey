import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  AfterClose,
  FieldWork,
  Auth,
  RequirePermission,
  can,
  type AuthContext,
} from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { CATI_REPO, type CatiRepo } from './cati-repo.js';
import { CatiService, NextBody, OutcomeBody } from './cati.service.js';

const PERM = { projectParam: 'projectId' } as const;
const CONDUCT = 'interviews.conduct';
const ShiftQuery = z.object({ since: z.iso.datetime({ offset: true }) });
const PeekQuery = z.object({ questionnaireId: z.uuid().optional() });

/** Telephone interviewing: the call queue, call outcomes and callbacks. */
@ApiTags('cati')
@Controller()
export class CatiController {
  constructor(
    @Inject(CATI_REPO) private readonly repo: CatiRepo,
    private readonly cati: CatiService,
  ) {}

  /**
   * The next case to call, locked to the caller, with a new call opened on it. 204 with the
   * reason in `x-queue-reason` (and the next callback time) when nothing can be called now.
   */
  @Post('projects/:projectId/cati/next')
  @FieldWork()
  @HttpCode(200)
  @RequirePermission(CONDUCT, PERM)
  @ApiBody({ schema: z.toJSONSchema(NextBody) as object })
  async next(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(NextBody)) body: z.infer<typeof NextBody>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.repo.inTenant(ctx.tenantId, (t) =>
      this.cati.next(t, ctx, projectId, body.questionnaireId, body.caseId),
    );
    if ('reason' in out) {
      res.status(204);
      res.setHeader('x-queue-reason', out.reason);
      if (out.nextAt) res.setHeader('x-next-callback', new Date(out.nextAt).toISOString());
      return;
    }
    return out;
  }

  /**
   * What "Next case" would serve now (a callback due, a new case, a retry), or why nothing
   * would: read only, nothing is locked or opened (19).
   */
  @Get('projects/:projectId/cati/peek')
  @RequirePermission(CONDUCT, PERM)
  peek(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(PeekQuery)) q: z.infer<typeof PeekQuery>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) =>
      this.cati.peek(t, ctx, projectId, q.questionnaireId),
    );
  }

  /** The caller's open call (dialling, or answered with its interview); 204 when none. */
  @Get('projects/:projectId/cati/current')
  @RequirePermission(CONDUCT, PERM)
  async current(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.repo.inTenant(ctx.tenantId, (t) => this.cati.current(t, ctx, projectId));
    if (!out) res.status(204);
    return out ?? undefined;
  }

  /** Records what happened on a call; answered starts the telephone interview. */
  @Post('cati/attempts/:id/outcome')
  @AfterClose()
  @HttpCode(200)
  @RequirePermission(CONDUCT, { anyProject: true })
  @ApiBody({ schema: z.toJSONSchema(OutcomeBody, { io: 'input' }) as object })
  outcome(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(OutcomeBody)) body: OutcomeBody,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cati.outcome(t, ctx, id, body));
  }

  /** Gives the case back without calling (not counted as an attempt). */
  @Post('cati/attempts/:id/release')
  @AfterClose()
  @HttpCode(200)
  @RequirePermission(CONDUCT, { anyProject: true })
  release(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cati.release(t, ctx, id));
  }

  /** The caller's shift so far: calls, contacts, completes and time on the phone since `since`. */
  @Get('projects/:projectId/cati/shift')
  @RequirePermission(CONDUCT, PERM)
  shift(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(ShiftQuery)) q: z.infer<typeof ShiftQuery>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) =>
      this.cati.shift(t, ctx, projectId, new Date(q.since)),
    );
  }

  /** The caller's callbacks and appointments, soonest first. */
  @Get('projects/:projectId/cati/callbacks')
  @RequirePermission(CONDUCT, PERM)
  callbacks(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cati.callbacks(t, ctx, projectId));
  }

  /** Makes a callback the next case this caller is served, even before it is due. */
  @Post('projects/:projectId/cati/callbacks/:caseId/pin')
  @FieldWork()
  @HttpCode(200)
  @RequirePermission(CONDUCT, PERM)
  pin(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cati.pin(t, ctx, projectId, caseId, true));
  }

  /** Takes it off again. */
  @Delete('projects/:projectId/cati/callbacks/:caseId/pin')
  @FieldWork()
  @RequirePermission(CONDUCT, PERM)
  unpin(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.cati.pin(t, ctx, projectId, caseId, false));
  }

  /** A case's calls, newest first (numbers by their last digits). */
  @Get('projects/:projectId/cases/:caseId/calls')
  @RequirePermission(['cases.read_all', 'cases.read_assigned'], PERM)
  calls(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const c = await t.caseBrief(projectId, caseId);
      if (!c || (!can(ctx.memberships, 'cases.read_all', projectId) && c.assignedTo !== ctx.userId))
        throw new NotFoundException('Case not found');
      return this.cati.history(t, caseId);
    });
  }
}
