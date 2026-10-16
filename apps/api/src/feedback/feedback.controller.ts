import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Auth, Public, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import {
  AnswerBody,
  CommentBody,
  FeedbackService,
  PaperBody,
  PointBody,
  PointPatch,
} from './feedback.service.js';

const PERM = { projectParam: 'projectId' } as const;

/** Quick feedback points of a project: set up by those who run web surveys. */
@ApiTags('feedback')
@Controller('projects/:projectId/feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get()
  @RequirePermission('cawi.waves', PERM)
  list(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.feedback.list(ctx.tenantId, projectId);
  }

  @Post()
  @RequirePermission('cawi.waves', PERM)
  @ApiBody({ schema: z.toJSONSchema(PointBody, { io: 'input' }) as object })
  create(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(PointBody)) body: z.infer<typeof PointBody>,
  ) {
    return this.feedback.create(ctx.tenantId, projectId, body);
  }

  @Patch(':id')
  @RequirePermission('cawi.waves', PERM)
  @ApiBody({ schema: z.toJSONSchema(PointPatch, { io: 'input' }) as object })
  update(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(PointPatch)) body: z.infer<typeof PointPatch>,
  ) {
    return this.feedback.update(ctx.tenantId, projectId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('cawi.waves', PERM)
  async remove(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.feedback.remove(ctx.tenantId, projectId, id);
  }

  @Get(':id/results')
  @RequirePermission('dashboards.read', PERM)
  results(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.feedback.results(ctx.tenantId, projectId, id);
  }

  /** One printed slip keyed in the office. */
  @Post(':id/paper')
  @HttpCode(200)
  @RequirePermission('cawi.waves', PERM)
  paper(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(PaperBody)) body: z.infer<typeof PaperBody>,
  ) {
    return this.feedback.paper(ctx.tenantId, projectId, id, body.score);
  }
}

const respondentLimit = { default: { limit: 60, ttl: 60_000 } };

/** The faces answered by anyone with the link (no sign-in). */
@ApiTags('public')
@Controller('public/f/:slug')
export class PublicFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Public()
  @Throttle(respondentLimit)
  @Get()
  get(@Param('slug') slug: string) {
    return this.feedback.publicPoint(slug);
  }

  @Public()
  @Throttle(respondentLimit)
  @Post()
  @HttpCode(200)
  @ApiBody({ schema: z.toJSONSchema(AnswerBody, { io: 'input' }) as object })
  answer(
    @Param('slug') slug: string,
    @Body(new ZodPipe(AnswerBody)) body: z.infer<typeof AnswerBody>,
  ) {
    return this.feedback.answer(slug, body);
  }

  @Public()
  @Throttle(respondentLimit)
  @Post('comment')
  @HttpCode(200)
  @ApiBody({ schema: z.toJSONSchema(CommentBody) as object })
  comment(
    @Param('slug') slug: string,
    @Body(new ZodPipe(CommentBody)) body: z.infer<typeof CommentBody>,
  ) {
    return this.feedback.comment(slug, body);
  }
}
