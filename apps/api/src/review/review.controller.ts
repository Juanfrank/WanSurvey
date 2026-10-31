import {
  Body,
  Controller,
  Inject,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { REVIEW_REPO, type ReviewRepo } from './review-repo.js';
import {
  AssignBody,
  CodesBody,
  CommentBody,
  CorrectBody,
  QueueQuery,
  ReviewService,
  TransitionBody,
} from './review.service.js';

const PERM = { projectParam: 'projectId' } as const;
const REVIEW = ['interviews.review', 'interviews.approve'] as const;
const REVIEW_OR_OWN = [
  'interviews.review',
  'interviews.approve',
  'interviews.conduct',
  'dataentry.key',
] as const;
const CODING = ['interviews.correct', 'interviews.review'] as const;
const Variable = z
  .string()
  .regex(/^[A-Za-z_][\w]*$/)
  .max(100);

/** Answer review: the queue, the review screen, status changes, corrections, comments, coding. */
@ApiTags('review')
@Controller()
export class ReviewController {
  constructor(
    @Inject(REVIEW_REPO) private readonly repo: ReviewRepo,
    private readonly review: ReviewService,
  ) {}

  @Get('projects/:projectId/review/queue')
  @RequirePermission(REVIEW, PERM)
  queue(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(QueueQuery)) q: z.infer<typeof QueueQuery>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.review.queue(t, projectId, q));
  }

  /** The caller's interviews returned for fixing. */
  @Get('projects/:projectId/review/returned')
  @RequirePermission(['interviews.conduct', 'dataentry.key'], PERM)
  returned(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.review.returned(t, ctx, projectId));
  }

  @Get('review/interviews/:id')
  @RequirePermission(REVIEW_OR_OWN, { anyProject: true })
  detail(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.review.detail(t, ctx, id));
  }

  @Post('review/interviews/:id/transition')
  @HttpCode(200)
  @RequirePermission(REVIEW, { anyProject: true })
  @ApiBody({ schema: z.toJSONSchema(TransitionBody) as object })
  transition(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(TransitionBody)) body: z.infer<typeof TransitionBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.review.transition(t, ctx, id, body));
  }

  @Post('review/interviews/:id/correct')
  @HttpCode(200)
  @RequirePermission('interviews.correct', { anyProject: true })
  @ApiBody({ schema: z.toJSONSchema(CorrectBody) as object })
  correct(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CorrectBody)) body: z.infer<typeof CorrectBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.review.correct(t, ctx, id, body));
  }

  @Post('review/interviews/:id/comments')
  @RequirePermission(REVIEW_OR_OWN, { anyProject: true })
  @ApiBody({ schema: z.toJSONSchema(CommentBody) as object })
  comment(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CommentBody)) body: z.infer<typeof CommentBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.review.addComment(t, ctx, id, body));
  }

  /** Marks a comment as dealt with (or open again). */
  @Post('review/comments/:id/resolve')
  @HttpCode(200)
  @RequirePermission(REVIEW_OR_OWN, { anyProject: true })
  resolve(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.review.resolveComment(t, ctx, id));
  }

  @Get('projects/:projectId/coding')
  @RequirePermission(CODING, PERM)
  coding(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.review.codingOverview(t, projectId));
  }

  @Get('projects/:projectId/coding/:variable')
  @RequirePermission(CODING, PERM)
  codingDetail(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('variable', new ZodPipe(Variable)) variable: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) =>
      this.review.codingDetail(t, projectId, variable),
    );
  }

  @Put('projects/:projectId/coding/:variable/codes')
  @RequirePermission(CODING, PERM)
  @ApiBody({ schema: z.toJSONSchema(CodesBody) as object })
  codes(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('variable', new ZodPipe(Variable)) variable: string,
    @Body(new ZodPipe(CodesBody)) body: z.infer<typeof CodesBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) =>
      this.review.saveCodes(t, ctx, projectId, variable, body),
    );
  }

  @Post('projects/:projectId/coding/:variable/assign')
  @HttpCode(200)
  @RequirePermission(CODING, PERM)
  @ApiBody({ schema: z.toJSONSchema(AssignBody) as object })
  assign(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('variable', new ZodPipe(Variable)) variable: string,
    @Body(new ZodPipe(AssignBody)) body: z.infer<typeof AssignBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) =>
      this.review.assign(t, ctx, projectId, variable, body),
    );
  }
}
