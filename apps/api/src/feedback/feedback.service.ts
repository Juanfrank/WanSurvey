import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LocalizedText } from '@wansurvey/schema';
import {
  FeedbackItems,
  feedbackAnswerError,
  feedbackItemShown,
  type FeedbackItem,
} from '@wansurvey/schema/feedback';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DisplayName } from '../common/zod.js';
import { randomToken, safeEqual, sha256Hex } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Database, type Tx } from '../db/database.js';
import { feedbackPoints, feedbackResponses } from '../db/schema.js';

export const PointBody = z.object({
  name: DisplayName,
  question: LocalizedText,
  faces: z.union([z.literal(3), z.literal(5)]).default(3),
  /** Older clients: a comment box becomes the first follow-up question. */
  askComment: z.boolean().default(true),
  items: FeedbackItems.optional(),
});
// No defaults here: a patch changes only what it names.
export const PointPatch = z.object({
  name: DisplayName.optional(),
  question: LocalizedText.optional(),
  faces: z.union([z.literal(3), z.literal(5)]).optional(),
  items: FeedbackItems.optional(),
  active: z.boolean().optional(),
});

/** Answers to follow-up questions, by item id. */
const Answers = z.record(
  z.string().max(32),
  z.union([z.string().max(2000), z.number(), z.array(z.number()).max(30), z.null()]),
);

export const AnswerBody = z.object({
  score: z.number().int().min(1).max(5),
  ref: z.string().trim().max(120).optional(),
  channel: z.enum(['link', 'widget']).default('link'),
  /** Raw link parameters (`?sede=2`): those a question takes answer it beforehand. */
  params: z.record(z.string().max(32), z.string().max(200)).optional(),
});
export const FollowUpBody = z.object({
  id: z.uuid(),
  key: z.string().min(16).max(64),
  answers: Answers,
});

const COMMENT_ITEM = (lang: string): FeedbackItem => ({
  id: 'COMENTARIO',
  type: 'text',
  long: true,
  required: false,
  text: {
    [lang]:
      lang === 'es' ? '¿Quiere contarnos algo más?' : 'Anything else you would like to tell us?',
  },
});

/** A link parameter as the answer its question takes, or undefined when it does not fit. */
function fromParam(item: FeedbackItem, raw: string): unknown {
  const n = Number(raw);
  switch (item.type) {
    case 'text':
      return raw;
    case 'number':
      return Number.isFinite(n) ? n : undefined;
    case 'yesno':
    case 'single':
      return Number.isInteger(n) ? n : undefined;
    case 'multi':
      return raw.split(/[,;]/).map(Number);
  }
}
export const CommentBody = z.object({
  id: z.uuid(),
  key: z.string().min(16).max(64),
  comment: z.string().trim().min(1).max(2000),
});
export const PaperBody = z.object({ score: z.number().int().min(1).max(5) });

const SLUG = /^[A-Za-z0-9_-]{6,32}$/;

/**
 * Quick feedback (F1): one question answered with faces. Each face is a link with the score
 * in the address (`/f/<slug>?r=3`); opening it records the answer from the page, so link
 * scanners in mail systems that only fetch the address do not count as answers.
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private url(slug: string) {
    return `${this.config.PUBLIC_WEB_URL.replace(/\/$/, '')}/f/${slug}`;
  }

  private shape(p: typeof feedbackPoints.$inferSelect) {
    return {
      id: p.id,
      name: p.name,
      question: p.question as Record<string, string>,
      faces: p.faces,
      askComment: p.askComment,
      active: p.active,
      slug: p.slug,
      url: this.url(p.slug),
      version: p.version,
      items: p.items as FeedbackItem[],
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  private async counts(tx: Tx, pointIds: string[]) {
    if (!pointIds.length) return new Map<string, Record<number, number>>();
    const rows = await tx
      .select({
        pointId: feedbackResponses.pointId,
        score: feedbackResponses.score,
        n: sql<number>`count(*)::int`,
      })
      .from(feedbackResponses)
      .where(inArray(feedbackResponses.pointId, pointIds))
      .groupBy(feedbackResponses.pointId, feedbackResponses.score);
    const out = new Map<string, Record<number, number>>();
    for (const r of rows) out.set(r.pointId, { ...(out.get(r.pointId) ?? {}), [r.score]: r.n });
    return out;
  }

  list(tenantId: string, projectId: string) {
    return this.database.withTenant(tenantId, async (tx) => {
      const points = await tx
        .select()
        .from(feedbackPoints)
        .where(eq(feedbackPoints.projectId, projectId))
        .orderBy(feedbackPoints.createdAt);
      const counts = await this.counts(
        tx,
        points.map((p) => p.id),
      );
      return points.map((p) => ({ ...this.shape(p), counts: counts.get(p.id) ?? {} }));
    });
  }

  create(tenantId: string, projectId: string, body: z.infer<typeof PointBody>) {
    return this.database.withTenant(tenantId, async (tx) => {
      const [p] = await tx
        .insert(feedbackPoints)
        .values({
          tenantId,
          projectId,
          name: body.name,
          question: body.question,
          faces: body.faces,
          askComment: body.askComment,
          items:
            body.items ??
            (body.askComment ? [COMMENT_ITEM(Object.keys(body.question)[0] ?? 'es')] : []),
          slug: randomToken(9),
        })
        .returning();
      return { ...this.shape(p!), counts: {} };
    });
  }

  update(tenantId: string, projectId: string, id: string, body: z.infer<typeof PointPatch>) {
    return this.database.withTenant(tenantId, async (tx) => {
      // A change to what is asked is a new version of the point.
      const asked =
        body.question !== undefined || body.faces !== undefined || body.items !== undefined;
      const [p] = await tx
        .update(feedbackPoints)
        .set({
          ...body,
          ...(asked ? { version: sql`${feedbackPoints.version} + 1`, updatedAt: new Date() } : {}),
        })
        .where(and(eq(feedbackPoints.id, id), eq(feedbackPoints.projectId, projectId)))
        .returning();
      if (!p) throw new NotFoundException('Feedback point not found');
      return this.shape(p);
    });
  }

  /** Deletes a point nobody answered (409 IN_USE otherwise: switch it off instead). */
  remove(tenantId: string, projectId: string, id: string) {
    return this.database.withTenant(tenantId, async (tx) => {
      const [p] = await tx
        .select({ id: feedbackPoints.id })
        .from(feedbackPoints)
        .where(and(eq(feedbackPoints.id, id), eq(feedbackPoints.projectId, projectId)))
        .for('update');
      if (!p) throw new NotFoundException('Feedback point not found');
      const [answered] = await tx
        .select({ id: feedbackResponses.id })
        .from(feedbackResponses)
        .where(eq(feedbackResponses.pointId, id))
        .limit(1);
      if (answered)
        throw new ConflictException({
          code: 'IN_USE',
          message: 'This feedback point has answers; switch it off instead',
        });
      await tx.delete(feedbackPoints).where(eq(feedbackPoints.id, id));
    });
  }

  /** Counts per face and the latest comments. */
  results(tenantId: string, projectId: string, id: string) {
    return this.database.withTenant(tenantId, async (tx) => {
      const [p] = await tx
        .select()
        .from(feedbackPoints)
        .where(and(eq(feedbackPoints.id, id), eq(feedbackPoints.projectId, projectId)));
      if (!p) throw new NotFoundException('Feedback point not found');
      const counts = (await this.counts(tx, [id])).get(id) ?? {};
      const byChannel = await tx
        .select({ channel: feedbackResponses.channel, n: sql<number>`count(*)::int` })
        .from(feedbackResponses)
        .where(eq(feedbackResponses.pointId, id))
        .groupBy(feedbackResponses.channel);
      const comments = await tx
        .select({
          score: feedbackResponses.score,
          comment: feedbackResponses.comment,
          ref: feedbackResponses.ref,
          at: feedbackResponses.createdAt,
        })
        .from(feedbackResponses)
        .where(and(eq(feedbackResponses.pointId, id), isNotNull(feedbackResponses.comment)))
        .orderBy(desc(feedbackResponses.createdAt))
        .limit(50);
      // Follow-up answers: counts per option, and the latest texts.
      const rows = await tx
        .select({
          score: feedbackResponses.score,
          answers: feedbackResponses.answers,
          ref: feedbackResponses.ref,
          at: feedbackResponses.createdAt,
        })
        .from(feedbackResponses)
        .where(and(eq(feedbackResponses.pointId, id), isNotNull(feedbackResponses.answers)))
        .orderBy(desc(feedbackResponses.createdAt))
        .limit(20_000);
      const items = p.items as FeedbackItem[];
      const itemCounts: Record<string, Record<string, number>> = {};
      const texts: { item: string; score: number; text: string; ref: string | null; at: Date }[] =
        [];
      for (const r of rows) {
        const a = (r.answers ?? {}) as Record<string, unknown>;
        for (const it of items) {
          const v = a[it.id];
          if (v === undefined || v === null) continue;
          if (it.type === 'text') {
            if (texts.length < 100)
              texts.push({ item: it.id, score: r.score, text: String(v), ref: r.ref, at: r.at });
            continue;
          }
          const bucket = (itemCounts[it.id] ??= {});
          for (const c of Array.isArray(v) ? v : [v])
            bucket[String(c)] = (bucket[String(c)] ?? 0) + 1;
        }
      }
      return {
        point: this.shape(p),
        counts,
        channels: Object.fromEntries(byChannel.map((c) => [c.channel, c.n])),
        comments,
        itemCounts,
        texts,
      };
    });
  }

  /** A slip answered on paper, keyed in the office. */
  paper(tenantId: string, projectId: string, id: string, score: number) {
    return this.database.withTenant(tenantId, async (tx) => {
      const [p] = await tx
        .select()
        .from(feedbackPoints)
        .where(and(eq(feedbackPoints.id, id), eq(feedbackPoints.projectId, projectId)));
      if (!p) throw new NotFoundException('Feedback point not found');
      if (score > p.faces) throw new NotFoundException('No such face');
      await tx.insert(feedbackResponses).values({ tenantId, pointId: id, score, channel: 'paper' });
      return { ok: true };
    });
  }

  /** The point's organisation found and set in the same transaction as the work. */
  private inPoint<T>(
    slug: string,
    fn: (tx: Tx, found: { id: string; tenantId: string }) => Promise<T>,
  ): Promise<T> {
    if (!SLUG.test(slug)) throw new NotFoundException('Not found');
    return this.database.withTenantOf('feedback_point_by_slug', slug, (tx, found) => {
      if (!found) throw new NotFoundException('Not found');
      return fn(tx, found);
    });
  }

  /** What the public page and the widget show. */
  async publicPoint(slug: string) {
    return this.inPoint(slug, async (tx, found) => {
      const [p] = await tx.select().from(feedbackPoints).where(eq(feedbackPoints.id, found.id));
      return {
        question: p!.question as Record<string, string>,
        faces: p!.faces,
        items: p!.items as FeedbackItem[],
        // Older pages read this; the comment is now an item.
        askComment: (p!.items as FeedbackItem[]).length > 0,
      };
    });
  }

  /** Records one face; the key lets the same browser add a comment to it. */
  async answer(slug: string, body: z.infer<typeof AnswerBody>) {
    return this.inPoint(slug, async (tx, found) => {
      const [p] = await tx.select().from(feedbackPoints).where(eq(feedbackPoints.id, found.id));
      if (body.score > p!.faces) throw new NotFoundException('No such face');
      const items = p!.items as FeedbackItem[];
      // Questions a link parameter answers are recorded now and never shown.
      const preset: Record<string, unknown> = {};
      for (const it of items) {
        const raw = it.param ? body.params?.[it.param] : undefined;
        if (raw === undefined) continue;
        const v = fromParam(it, raw);
        if (v !== undefined && !feedbackAnswerError(it, v)) preset[it.id] = v;
      }
      const open = items.some((it) => !(it.id in preset) && feedbackItemShown(it, body.score));
      const key = randomToken(18);
      const [r] = await tx
        .insert(feedbackResponses)
        .values({
          tenantId: found.tenantId,
          pointId: found.id,
          score: body.score,
          channel: body.channel,
          ref: body.ref ?? null,
          answers: Object.keys(preset).length ? preset : null,
          editHash: open ? sha256Hex(key) : null,
        })
        .returning({ id: feedbackResponses.id });
      return { id: r!.id, preset: Object.keys(preset), ...(open ? { key } : {}) };
    });
  }

  /** The follow-up answers of one face, once (the key is spent). */
  async followUp(slug: string, body: z.infer<typeof FollowUpBody>) {
    return this.inPoint(slug, async (tx, found) => {
      const [p] = await tx.select().from(feedbackPoints).where(eq(feedbackPoints.id, found.id));
      const [r] = await tx
        .select()
        .from(feedbackResponses)
        .where(and(eq(feedbackResponses.id, body.id), eq(feedbackResponses.pointId, found.id)))
        .for('update');
      if (!r?.editHash || !safeEqual(r.editHash, sha256Hex(body.key)))
        throw new NotFoundException('Not found');
      const before = (r.answers ?? {}) as Record<string, unknown>;
      const answers: Record<string, unknown> = { ...before };
      const problems: Record<string, string> = {};
      for (const it of p!.items as FeedbackItem[]) {
        if (it.id in before || !feedbackItemShown(it, r.score)) continue;
        const v = body.answers[it.id] ?? null;
        const err = feedbackAnswerError(it, v);
        if (err) problems[it.id] = err;
        else if (v !== null && v !== '') answers[it.id] = typeof v === 'string' ? v.trim() : v;
      }
      if (Object.keys(problems).length)
        throw new BadRequestException({
          code: 'INVALID_ANSWERS',
          message: 'Check the answers',
          problems,
        });
      const text = (p!.items as FeedbackItem[]).find((it) => it.type === 'text' && it.long);
      await tx
        .update(feedbackResponses)
        .set({
          answers,
          editHash: null,
          ...(text && typeof answers[text.id] === 'string'
            ? { comment: answers[text.id] as string }
            : {}),
        })
        .where(eq(feedbackResponses.id, r.id));
      return { ok: true };
    });
  }

  async comment(slug: string, body: z.infer<typeof CommentBody>) {
    return this.inPoint(slug, async (tx, found) => {
      const [r] = await tx
        .select()
        .from(feedbackResponses)
        .where(and(eq(feedbackResponses.id, body.id), eq(feedbackResponses.pointId, found.id)))
        .for('update');
      if (!r?.editHash || !safeEqual(r.editHash, sha256Hex(body.key)))
        throw new NotFoundException('Not found');
      // One comment per answer: the key is spent.
      await tx
        .update(feedbackResponses)
        .set({ comment: body.comment, editHash: null })
        .where(eq(feedbackResponses.id, r.id));
      return { ok: true };
    });
  }
}
