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
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { AnswerOption, ContainerItemSchema, LanguageCode } from '@wansurvey/schema';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { DisplayName, ZodPipe } from '../common/zod.js';
import {
  QUESTIONNAIRES_REPO,
  type QuestionnairesRepo,
} from '../questionnaires/questionnaires-repo.js';

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
    @Inject(QUESTIONNAIRES_REPO) private readonly repo: QuestionnairesRepo,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('questionnaires.read', ANY)
  list(@Auth() ctx: AuthContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.repo.inTenant(ctx.tenantId, (t) => t.libraryList({ text: q.q, tag: q.tag }));
  }

  @Post()
  @RequirePermission('questionnaires.edit', ANY)
  @ApiBody({ schema: z.toJSONSchema(ItemBody, { io: 'input' }) as object })
  create(@Auth() ctx: AuthContext, @Body(new ZodPipe(ItemBody)) body: z.infer<typeof ItemBody>) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const row = await t.libraryCreate({
        name: body.name,
        description: body.description ?? null,
        tags: body.tags,
        languages: body.languages,
        content: body.content,
        userId: ctx.userId,
      });
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'library_item.created',
          targetType: 'library_item',
          targetId: row.id,
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const row = await t.libraryUpdate(id, body);
      if (!row) throw new NotFoundException('Library item not found');
      return row;
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('questionnaires.edit', ANY)
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.repo.inTenant(ctx.tenantId, async (t) => {
      const row = await t.libraryDelete(id);
      if (!row) throw new NotFoundException('Library item not found');
      await t.audit(
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
