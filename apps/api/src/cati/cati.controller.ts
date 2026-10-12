import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { Auth, RequirePermission, can, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { cases } from '../db/schema.js';
import { CatiService, NextBody, OutcomeBody } from './cati.service.js';

const PERM = { projectParam: 'projectId' } as const;
const CONDUCT = 'interviews.conduct';

/** Telephone interviewing: the call queue, call outcomes and callbacks. */
@ApiTags('cati')
@Controller()
export class CatiController {
  constructor(
    private readonly database: Database,
    private readonly cati: CatiService,
  ) {}

  /**
   * The next case to call, locked to the caller, with a new call opened on it. 204 with the
   * reason in `x-queue-reason` (and the next callback time) when nothing can be called now.
   */
  @Post('projects/:projectId/cati/next')
  @HttpCode(200)
  @RequirePermission(CONDUCT, PERM)
  @ApiBody({ schema: z.toJSONSchema(NextBody) as object })
  async next(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(NextBody)) body: z.infer<typeof NextBody>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.database.withTenant(ctx.tenantId, (tx) =>
      this.cati.next(tx, ctx, projectId, body.questionnaireId),
    );
    if ('reason' in out) {
      res.status(204);
      res.setHeader('x-queue-reason', out.reason);
      if (out.nextAt) res.setHeader('x-next-callback', new Date(out.nextAt).toISOString());
      return;
    }
    return out;
  }

  /** The caller's open call (dialling, or answered with its interview); 204 when none. */
  @Get('projects/:projectId/cati/current')
  @RequirePermission(CONDUCT, PERM)
  async current(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.database.withTenant(ctx.tenantId, (tx) =>
      this.cati.current(tx, ctx, projectId),
    );
    if (!out) res.status(204);
    return out ?? undefined;
  }

  /** Records what happened on a call; answered starts the telephone interview. */
  @Post('cati/attempts/:id/outcome')
  @HttpCode(200)
  @RequirePermission(CONDUCT, { anyProject: true })
  @ApiBody({ schema: z.toJSONSchema(OutcomeBody, { io: 'input' }) as object })
  outcome(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(OutcomeBody)) body: OutcomeBody,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.cati.outcome(tx, ctx, id, body));
  }

  /** Gives the case back without calling (not counted as an attempt). */
  @Post('cati/attempts/:id/release')
  @HttpCode(200)
  @RequirePermission(CONDUCT, { anyProject: true })
  release(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.cati.release(tx, ctx, id));
  }

  /** The caller's callbacks and appointments, soonest first. */
  @Get('projects/:projectId/cati/callbacks')
  @RequirePermission(CONDUCT, PERM)
  callbacks(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.cati.callbacks(tx, ctx, projectId));
  }

  /** A case's calls, newest first (numbers by their last digits). */
  @Get('projects/:projectId/cases/:caseId/calls')
  @RequirePermission(['cases.read_all', 'cases.read_assigned'], PERM)
  calls(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [c] = await tx
        .select({ assignedTo: cases.assignedTo })
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.projectId, projectId)));
      if (!c || (!can(ctx.memberships, 'cases.read_all', projectId) && c.assignedTo !== ctx.userId))
        throw new NotFoundException('Case not found');
      return this.cati.history(tx, caseId);
    });
  }
}
