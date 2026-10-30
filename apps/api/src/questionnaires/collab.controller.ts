import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
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
import {
  QUESTIONNAIRES_REPO,
  type QuestionnairesRepo,
  type QuestionnairesTx,
} from './questionnaires-repo.js';

const BASE = 'projects/:projectId/questionnaires/:qid';
const PERM = { projectParam: 'projectId' } as const;
const WRITE = ['questionnaires.edit', 'questionnaires.comment'] as const;
/** Editors seen within this window count as present. */
export const PRESENCE_WINDOW_MS = 30_000;

const CommentBody = z.object({
  /** The item commented on; null or absent for the questionnaire as a whole. */
  itemId: z.string().min(1).max(100).nullable().optional(),
  /** Replies point to the first comment of a thread. */
  parentId: z.uuid().optional(),
  body: z.string().trim().min(1).max(5000),
});
const PresenceBody = z.object({ itemId: z.string().min(1).max(100).nullable() });
const ListQuery = z.object({ status: z.enum(['open', 'all']).default('all') });

/**
 * Working together on a questionnaire: review comments on items, and presence (who has it
 * open, on which item) with the draft's head revision, polled by every open designer.
 */
@ApiTags('questionnaires')
@Controller(BASE)
export class CollabController {
  constructor(@Inject(QUESTIONNAIRES_REPO) private readonly repo: QuestionnairesRepo) {}

  // ---- Comments ------------------------------------------------------------------------

  @Get('comments')
  @RequirePermission('questionnaires.read', PERM)
  comments(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      const rows = await t.comments(qid);
      const open = new Set(rows.filter((r) => !r.parentId && !r.resolvedAt).map((r) => r.id));
      return rows
        .filter((r) => q.status === 'all' || open.has(r.parentId ?? r.id))
        .map((r) => ({ ...r, mine: r.authorId === ctx.userId }));
    });
  }

  @Post('comments')
  @RequirePermission(WRITE, PERM)
  @ApiBody({ schema: z.toJSONSchema(CommentBody) as object })
  comment(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Body(new ZodPipe(CommentBody)) body: z.infer<typeof CommentBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      let itemId = body.itemId ?? null;
      if (body.parentId) {
        const parent = await this.thread(t, qid, body.parentId);
        itemId = parent.itemId;
        // A reply reopens a resolved thread: there is something new to look at.
        if (parent.resolvedAt) await t.setResolved(parent.id, null);
      }
      return t.addComment({
        questionnaireId: qid,
        itemId,
        parentId: body.parentId ?? null,
        authorId: ctx.userId,
        body: body.body,
      });
    });
  }

  @Post('comments/:commentId/resolve')
  @HttpCode(200)
  @RequirePermission(WRITE, PERM)
  resolve(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    return this.setResolved(ctx, projectId, qid, commentId, true);
  }

  @Post('comments/:commentId/reopen')
  @HttpCode(200)
  @RequirePermission(WRITE, PERM)
  reopen(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    return this.setResolved(ctx, projectId, qid, commentId, false);
  }

  /** People delete their own comments, as long as nobody has replied. */
  @Delete('comments/:commentId')
  @HttpCode(204)
  @RequirePermission(WRITE, PERM)
  async remove(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ): Promise<void> {
    await this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      const c = await t.comment(qid, commentId);
      if (!c) throw new NotFoundException('Comment not found');
      if (c.authorId !== ctx.userId)
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'Only the author can delete a comment',
        });
      if (await t.hasReplies(commentId))
        throw new ConflictException({
          code: 'HAS_REPLIES',
          message: 'A comment with replies cannot be deleted; resolve the thread instead',
        });
      await t.deleteComment(commentId);
    });
  }

  // ---- Presence ------------------------------------------------------------------------

  /** Heartbeat: "I have it open, on this item". Returns the others and the draft head. */
  @Put('presence')
  @RequirePermission('questionnaires.read', PERM)
  @ApiBody({ schema: z.toJSONSchema(PresenceBody) as object })
  heartbeat(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Body(new ZodPipe(PresenceBody)) body: z.infer<typeof PresenceBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      await t.touchPresence(qid, ctx.userId, body.itemId);
      return this.state(t, ctx, qid);
    });
  }

  @Get('presence')
  @RequirePermission('questionnaires.read', PERM)
  presence(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      return this.state(t, ctx, qid);
    });
  }

  /** Leaving the designer. */
  @Delete('presence')
  @HttpCode(204)
  @RequirePermission('questionnaires.read', PERM)
  async leave(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
  ): Promise<void> {
    await this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      await t.leavePresence(qid, ctx.userId);
    });
  }

  // ----------------------------------------------------------------------------------------

  private async state(t: QuestionnairesTx, ctx: AuthContext, qid: string) {
    const editors = await t.editors(qid, new Date(Date.now() - PRESENCE_WINDOW_MS));
    const head = await t.head(qid);
    return { editors: editors.filter((e) => e.userId !== ctx.userId), head };
  }

  private setResolved(
    ctx: AuthContext,
    projectId: string,
    qid: string,
    commentId: string,
    resolved: boolean,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      const c = await this.thread(t, qid, commentId);
      return t.setResolved(c.id, resolved ? ctx.userId : null);
    });
  }

  /** The first comment of a thread (replies cannot be replied to, resolved or reopened). */
  private async thread(t: QuestionnairesTx, qid: string, id: string) {
    const c = await t.comment(qid, id);
    if (!c) throw new NotFoundException('Comment not found');
    if (c.parentId)
      throw new BadRequestException({
        code: 'NOT_A_THREAD',
        message: 'Replies and resolving apply to the first comment of a thread',
      });
    return c;
  }

  private async questionnaire(t: QuestionnairesTx, projectId: string, qid: string) {
    const q = await t.get(projectId, qid);
    if (!q) throw new NotFoundException('Questionnaire not found');
    return q;
  }
}
