import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { LocalizedText } from '@wansurvey/schema';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomToken, safeEqual, sha256Hex } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Database, type Tx } from '../db/database.js';
import { feedbackPoints, feedbackResponses } from '../db/schema.js';

export const PointBody = z.object({
  name: z.string().trim().min(1).max(200),
  question: LocalizedText,
  faces: z.union([z.literal(3), z.literal(5)]).default(3),
  askComment: z.boolean().default(true),
});
export const PointPatch = PointBody.partial().extend({ active: z.boolean().optional() });

export const AnswerBody = z.object({
  score: z.number().int().min(1).max(5),
  ref: z.string().trim().max(120).optional(),
  channel: z.enum(['link', 'widget']).default('link'),
});
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
      createdAt: p.createdAt,
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
        .values({ tenantId, projectId, ...body, slug: randomToken(9) })
        .returning();
      return { ...this.shape(p!), counts: {} };
    });
  }

  update(tenantId: string, projectId: string, id: string, body: z.infer<typeof PointPatch>) {
    return this.database.withTenant(tenantId, async (tx) => {
      const [p] = await tx
        .update(feedbackPoints)
        .set(body)
        .where(and(eq(feedbackPoints.id, id), eq(feedbackPoints.projectId, projectId)))
        .returning();
      if (!p) throw new NotFoundException('Feedback point not found');
      return this.shape(p);
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
      return {
        point: this.shape(p),
        counts,
        channels: Object.fromEntries(byChannel.map((c) => [c.channel, c.n])),
        comments,
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

  private async bySlug(slug: string) {
    if (!SLUG.test(slug)) throw new NotFoundException('Not found');
    const found = await this.database.feedbackPointBySlug(slug);
    if (!found) throw new NotFoundException('Not found');
    return found;
  }

  /** What the public page and the widget show. */
  async publicPoint(slug: string) {
    const found = await this.bySlug(slug);
    return this.database.withTenant(found.tenantId, async (tx) => {
      const [p] = await tx.select().from(feedbackPoints).where(eq(feedbackPoints.id, found.id));
      return {
        question: p!.question as Record<string, string>,
        faces: p!.faces,
        askComment: p!.askComment,
      };
    });
  }

  /** Records one face; the key lets the same browser add a comment to it. */
  async answer(slug: string, body: z.infer<typeof AnswerBody>) {
    const found = await this.bySlug(slug);
    return this.database.withTenant(found.tenantId, async (tx) => {
      const [p] = await tx.select().from(feedbackPoints).where(eq(feedbackPoints.id, found.id));
      if (body.score > p!.faces) throw new NotFoundException('No such face');
      const key = randomToken(18);
      const [r] = await tx
        .insert(feedbackResponses)
        .values({
          tenantId: found.tenantId,
          pointId: found.id,
          score: body.score,
          channel: body.channel,
          ref: body.ref ?? null,
          editHash: p!.askComment ? sha256Hex(key) : null,
        })
        .returning({ id: feedbackResponses.id });
      return { id: r!.id, ...(p!.askComment ? { key } : {}) };
    });
  }

  async comment(slug: string, body: z.infer<typeof CommentBody>) {
    const found = await this.bySlug(slug);
    return this.database.withTenant(found.tenantId, async (tx) => {
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
