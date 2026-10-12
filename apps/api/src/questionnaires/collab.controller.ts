import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database, type Tx } from '../db/database.js';
import {
  questionnaireComments,
  questionnairePresence,
  questionnaires,
  users,
} from '../db/schema.js';

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
  constructor(private readonly database: Database) {}

  // ---- Comments ------------------------------------------------------------------------

  @Get('comments')
  @RequirePermission('questionnaires.read', PERM)
  comments(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      const author = alias(users, 'author');
      const resolver = alias(users, 'resolver');
      const rows = await tx
        .select({
          id: questionnaireComments.id,
          itemId: questionnaireComments.itemId,
          parentId: questionnaireComments.parentId,
          authorId: questionnaireComments.authorId,
          authorName: author.name,
          body: questionnaireComments.body,
          resolvedAt: questionnaireComments.resolvedAt,
          resolvedByName: resolver.name,
          createdAt: questionnaireComments.createdAt,
        })
        .from(questionnaireComments)
        .leftJoin(author, eq(author.id, questionnaireComments.authorId))
        .leftJoin(resolver, eq(resolver.id, questionnaireComments.resolvedBy))
        .where(eq(questionnaireComments.questionnaireId, qid))
        .orderBy(asc(questionnaireComments.createdAt));
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
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      let itemId = body.itemId ?? null;
      if (body.parentId) {
        const parent = await this.thread(tx, qid, body.parentId);
        itemId = parent.itemId;
        // A reply reopens a resolved thread: there is something new to look at.
        if (parent.resolvedAt)
          await tx
            .update(questionnaireComments)
            .set({ resolvedAt: null, resolvedBy: null, updatedAt: new Date() })
            .where(eq(questionnaireComments.id, parent.id));
      }
      const [row] = await tx
        .insert(questionnaireComments)
        .values({
          tenantId: ctx.tenantId,
          questionnaireId: qid,
          itemId,
          parentId: body.parentId ?? null,
          authorId: ctx.userId,
          body: body.body,
        })
        .returning();
      return row;
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
    await this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      const [c] = await tx
        .select()
        .from(questionnaireComments)
        .where(
          and(
            eq(questionnaireComments.id, commentId),
            eq(questionnaireComments.questionnaireId, qid),
          ),
        );
      if (!c) throw new NotFoundException('Comment not found');
      if (c.authorId !== ctx.userId)
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'Only the author can delete a comment',
        });
      const [reply] = await tx
        .select({ id: questionnaireComments.id })
        .from(questionnaireComments)
        .where(eq(questionnaireComments.parentId, commentId))
        .limit(1);
      if (reply)
        throw new ConflictException({
          code: 'HAS_REPLIES',
          message: 'A comment with replies cannot be deleted; resolve the thread instead',
        });
      await tx.delete(questionnaireComments).where(eq(questionnaireComments.id, commentId));
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
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      await tx
        .insert(questionnairePresence)
        .values({
          tenantId: ctx.tenantId,
          questionnaireId: qid,
          userId: ctx.userId,
          itemId: body.itemId,
        })
        .onConflictDoUpdate({
          target: [questionnairePresence.questionnaireId, questionnairePresence.userId],
          set: { itemId: body.itemId, lastSeen: sql`now()` },
        });
      return this.state(tx, ctx, qid);
    });
  }

  @Get('presence')
  @RequirePermission('questionnaires.read', PERM)
  presence(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      return this.state(tx, ctx, qid);
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
    await this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      await tx
        .delete(questionnairePresence)
        .where(
          and(
            eq(questionnairePresence.questionnaireId, qid),
            eq(questionnairePresence.userId, ctx.userId),
          ),
        );
    });
  }

  // ----------------------------------------------------------------------------------------

  private async state(tx: Tx, ctx: AuthContext, qid: string) {
    const editors = await tx
      .select({
        userId: questionnairePresence.userId,
        name: users.name,
        itemId: questionnairePresence.itemId,
        lastSeen: questionnairePresence.lastSeen,
      })
      .from(questionnairePresence)
      .innerJoin(users, eq(users.id, questionnairePresence.userId))
      .where(
        and(
          eq(questionnairePresence.questionnaireId, qid),
          gte(questionnairePresence.lastSeen, new Date(Date.now() - PRESENCE_WINDOW_MS)),
        ),
      )
      .orderBy(asc(users.name));
    const [head] = await tx
      .select({
        draftRevision: questionnaires.draftRevision,
        updatedAt: questionnaires.updatedAt,
        updatedById: questionnaires.updatedBy,
        updatedBy: users.name,
      })
      .from(questionnaires)
      .leftJoin(users, eq(users.id, questionnaires.updatedBy))
      .where(eq(questionnaires.id, qid));
    return { editors: editors.filter((e) => e.userId !== ctx.userId), head };
  }

  private setResolved(
    ctx: AuthContext,
    projectId: string,
    qid: string,
    commentId: string,
    resolved: boolean,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      const c = await this.thread(tx, qid, commentId);
      const [row] = await tx
        .update(questionnaireComments)
        .set({
          resolvedAt: resolved ? new Date() : null,
          resolvedBy: resolved ? ctx.userId : null,
          updatedAt: new Date(),
        })
        .where(eq(questionnaireComments.id, c.id))
        .returning();
      return row;
    });
  }

  /** The first comment of a thread (replies cannot be replied to, resolved or reopened). */
  private async thread(tx: Tx, qid: string, id: string) {
    const [c] = await tx
      .select()
      .from(questionnaireComments)
      .where(and(eq(questionnaireComments.id, id), eq(questionnaireComments.questionnaireId, qid)));
    if (!c) throw new NotFoundException('Comment not found');
    if (c.parentId)
      throw new BadRequestException({
        code: 'NOT_A_THREAD',
        message: 'Replies and resolving apply to the first comment of a thread',
      });
    return c;
  }

  private async questionnaire(tx: Tx, projectId: string, qid: string) {
    const [q] = await tx
      .select({ id: questionnaires.id })
      .from(questionnaires)
      .where(and(eq(questionnaires.id, qid), eq(questionnaires.projectId, projectId)));
    if (!q) throw new NotFoundException('Questionnaire not found');
    return q;
  }
}
