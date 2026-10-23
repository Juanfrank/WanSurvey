import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { AnswerOption, ContainerItemSchema, LanguageCode } from '@wansurvey/schema';
import { and, arrayContains, asc, eq, ilike, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { DisplayName, ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { libraryItems, users } from '../db/schema.js';

const ANY = { anyProject: true } as const;

/** What a library entry holds: one item, block or roster, and the answer sets it uses. */
const Content = z.object({
  node: ContainerItemSchema,
  answerSets: z.record(z.string(), z.array(AnswerOption)).default({}),
});
const ItemBody = z.object({
  name: DisplayName,
  description: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  languages: z.array(LanguageCode).min(1),
  content: Content,
});
const ItemPatch = ItemBody.omit({ content: true, languages: true }).partial();
const ListQuery = z.object({
  q: z.string().max(200).optional(),
  tag: z.string().max(40).optional(),
});

/**
 * The organisation's question library: reusable items, blocks and rosters (demographics,
 * consent, …) with their answer sets and translations. Anyone who can read questionnaires
 * browses it; editors add to it.
 */
@ApiTags('library')
@Controller('library')
export class LibraryController {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('questionnaires.read', ANY)
  list(@Auth() ctx: AuthContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const conds: SQL[] = [];
      if (q.q) {
        const term = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`;
        conds.push(or(ilike(libraryItems.name, term), ilike(libraryItems.description, term))!);
      }
      if (q.tag) conds.push(arrayContains(libraryItems.tags, [q.tag]));
      return tx
        .select({
          id: libraryItems.id,
          name: libraryItems.name,
          description: libraryItems.description,
          tags: libraryItems.tags,
          languages: libraryItems.languages,
          content: libraryItems.content,
          createdBy: users.name,
          updatedAt: libraryItems.updatedAt,
        })
        .from(libraryItems)
        .leftJoin(users, eq(users.id, libraryItems.createdBy))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(asc(libraryItems.name))
        .limit(200);
    });
  }

  @Post()
  @RequirePermission('questionnaires.edit', ANY)
  @ApiBody({ schema: z.toJSONSchema(ItemBody, { io: 'input' }) as object })
  create(@Auth() ctx: AuthContext, @Body(new ZodPipe(ItemBody)) body: z.infer<typeof ItemBody>) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(libraryItems)
        .values({
          tenantId: ctx.tenantId,
          name: body.name,
          description: body.description ?? null,
          tags: body.tags,
          languages: body.languages,
          content: body.content,
          createdBy: ctx.userId,
        })
        .returning();
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'library_item.created',
          targetType: 'library_item',
          targetId: row!.id,
          details: { name: body.name, item: body.content.node.id },
        }),
      );
      return row;
    });
  }

  @Patch(':id')
  @RequirePermission('questionnaires.edit', ANY)
  @ApiBody({ schema: z.toJSONSchema(ItemPatch) as object })
  update(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ItemPatch)) body: z.infer<typeof ItemPatch>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .update(libraryItems)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(libraryItems.id, id))
        .returning();
      if (!row) throw new NotFoundException('Library item not found');
      return row;
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('questionnaires.edit', ANY)
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.database.withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .delete(libraryItems)
        .where(eq(libraryItems.id, id))
        .returning({ id: libraryItems.id, name: libraryItems.name });
      if (!row) throw new NotFoundException('Library item not found');
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'library_item.deleted',
          targetType: 'library_item',
          targetId: id,
          details: { name: row.name },
        }),
      );
    });
  }
}
