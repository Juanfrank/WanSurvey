import { Injectable } from '@nestjs/common';
import { sql as ksql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';

/**
 * The database side of quick feedback, whichever engine runs (the pattern of
 * `auth/auth-repo.ts`).
 */
export interface PointView {
  id: string;
  tenantId: string;
  projectId: string;
  name: string;
  question: unknown;
  faces: number;
  askComment: boolean;
  slug: string;
  active: boolean;
  version: number;
  items: unknown;
  createdAt: Date;
  updatedAt: Date;
}
export interface ResponseView {
  id: string;
  tenantId: string;
  pointId: string;
  score: number;
  channel: string;
  ref: string | null;
  comment: string | null;
  editHash: string | null;
  answers: unknown;
  createdAt: Date;
}

export interface PointPatchView {
  name?: string;
  question?: Record<string, string>;
  faces?: number;
  items?: unknown[];
  active?: boolean;
}

export interface FeedbackTx {
  points(projectId: string): Promise<PointView[]>;
  /** Answers per point and score. */
  counts(pointIds: string[]): Promise<{ pointId: string; score: number; n: number }[]>;
  insertPoint(v: {
    projectId: string;
    name: string;
    question: Record<string, string>;
    faces: number;
    askComment: boolean;
    items: unknown[];
    slug: string;
  }): Promise<PointView>;
  /** A change to what is asked (`asked`) is a new version of the point. */
  updatePoint(
    projectId: string,
    id: string,
    patch: PointPatchView,
    asked: boolean,
  ): Promise<PointView | null>;
  point(projectId: string, id: string, lock?: boolean): Promise<PointView | null>;
  pointById(id: string): Promise<PointView | null>;
  hasResponses(pointId: string): Promise<boolean>;
  deletePoint(id: string): Promise<void>;
  channels(pointId: string): Promise<{ channel: string; n: number }[]>;
  comments(
    pointId: string,
    limit: number,
  ): Promise<{ score: number; comment: string | null; ref: string | null; at: Date }[]>;
  answered(
    pointId: string,
    limit: number,
  ): Promise<{ score: number; answers: unknown; ref: string | null; at: Date }[]>;
  insertResponse(v: {
    pointId: string;
    score: number;
    channel: string;
    ref?: string | null;
    answers?: Record<string, unknown> | null;
    editHash?: string | null;
  }): Promise<string>;
  /** The response, locked. */
  lockResponse(pointId: string, id: string): Promise<ResponseView | null>;
  updateResponse(
    id: string,
    patch: { answers?: Record<string, unknown>; comment?: string; editHash: null },
  ): Promise<void>;
}

export interface FeedbackRepo {
  inTenant<T>(tenantId: string, fn: (t: FeedbackTx) => Promise<T>): Promise<T>;
  /** The point's organisation found and set in the same transaction as the work. */
  ofSlug<T>(
    slug: string,
    fn: (t: FeedbackTx, found: { id: string; tenantId: string } | null) => Promise<T>,
  ): Promise<T>;
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));

function toPoint(r: Record<string, unknown>): PointView {
  const g = (k: string) => r[k] as never;
  return {
    id: low(r.id as string),
    tenantId: low(r.tenant_id as string),
    projectId: low(r.project_id as string),
    name: g('name'),
    question: parse(r.question as string),
    faces: g('faces'),
    askComment: !!r.ask_comment,
    slug: g('slug'),
    active: !!r.active,
    version: g('version'),
    items: parse(r.items as string),
    createdAt: g('created_at'),
    updatedAt: g('updated_at'),
  } as unknown as PointView;
}

function toResponse(r: Record<string, unknown>): ResponseView {
  const g = (k: string) => r[k] as never;
  return {
    id: low(r.id as string),
    tenantId: low(r.tenant_id as string),
    pointId: low(r.point_id as string),
    score: g('score'),
    channel: g('channel'),
    ref: g('ref'),
    comment: g('comment'),
    editHash: g('edit_hash'),
    answers: r.answers === null ? null : parse(r.answers as string),
    createdAt: g('created_at'),
  } as unknown as ResponseView;
}

export class MssqlFeedbackTx implements FeedbackTx {
  constructor(
    private readonly tx: MssqlTx,
    private readonly tenant: string,
  ) {}

  async points(projectId: string) {
    const rows = await this.tx
      .selectFrom('feedback_points')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at')
      .execute();
    return rows.map((r) => toPoint(r as never));
  }

  async counts(pointIds: string[]) {
    if (!pointIds.length) return [];
    const rows = await this.tx
      .selectFrom('feedback_responses')
      .select(['point_id', 'score', ksql<number>`COUNT(*)`.as('n')])
      .where('point_id', 'in', pointIds)
      .groupBy(['point_id', 'score'])
      .execute();
    return rows.map((r) => ({ pointId: low(r.point_id), score: r.score, n: Number(r.n) }));
  }

  async insertPoint(v: Parameters<FeedbackTx['insertPoint']>[0]) {
    const id = randomUUID();
    await this.tx
      .insertInto('feedback_points')
      .values({
        id,
        tenant_id: this.tenant,
        project_id: v.projectId,
        name: v.name,
        question: JSON.stringify(v.question),
        faces: v.faces,
        ask_comment: v.askComment,
        slug: v.slug,
        items: JSON.stringify(v.items),
      })
      .execute();
    return (await this.pointById(id))!;
  }

  async updatePoint(projectId: string, id: string, patch: PointPatchView, asked: boolean) {
    const existing = await this.point(projectId, id);
    if (!existing) return null;
    await this.tx
      .updateTable('feedback_points')
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.faces !== undefined ? { faces: patch.faces } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        ...(patch.question !== undefined ? { question: JSON.stringify(patch.question) } : {}),
        ...(patch.items !== undefined ? { items: JSON.stringify(patch.items) } : {}),
        ...(asked
          ? { version: ksql<number>`version + 1`, updated_at: ksql<Date>`SYSDATETIMEOFFSET()` }
          : {}),
      })
      .where('id', '=', id)
      .execute();
    return this.pointById(id);
  }

  async point(projectId: string, id: string, lock = false) {
    const res = lock
      ? await ksql<Record<string, unknown>>`
          SELECT * FROM dbo.feedback_points WITH (UPDLOCK, ROWLOCK)
          WHERE id = ${id} AND project_id = ${projectId}`.execute(this.tx)
      : await ksql<Record<string, unknown>>`
          SELECT * FROM dbo.feedback_points WHERE id = ${id} AND project_id = ${projectId}`.execute(
          this.tx,
        );
    return res.rows[0] ? toPoint(res.rows[0]) : null;
  }

  async pointById(id: string) {
    const r = await this.tx
      .selectFrom('feedback_points')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? toPoint(r as never) : null;
  }

  async hasResponses(pointId: string) {
    const r = await this.tx
      .selectFrom('feedback_responses')
      .select('id')
      .where('point_id', '=', pointId)
      .top(1)
      .executeTakeFirst();
    return !!r;
  }

  async deletePoint(id: string) {
    await this.tx.deleteFrom('feedback_points').where('id', '=', id).execute();
  }

  async channels(pointId: string) {
    const rows = await this.tx
      .selectFrom('feedback_responses')
      .select(['channel', ksql<number>`COUNT(*)`.as('n')])
      .where('point_id', '=', pointId)
      .groupBy('channel')
      .execute();
    return rows.map((r) => ({ channel: r.channel, n: Number(r.n) }));
  }

  async comments(pointId: string, limit: number) {
    const rows = await this.tx
      .selectFrom('feedback_responses')
      .select(['score', 'comment', 'ref', 'created_at'])
      .where('point_id', '=', pointId)
      .where('comment', 'is not', null)
      .orderBy('created_at', 'desc')
      .top(limit)
      .execute();
    return rows.map((r) => ({
      score: r.score,
      comment: r.comment,
      ref: r.ref,
      at: r.created_at as Date,
    }));
  }

  async answered(pointId: string, limit: number) {
    const rows = await this.tx
      .selectFrom('feedback_responses')
      .select(['score', 'answers', 'ref', 'created_at'])
      .where('point_id', '=', pointId)
      .where('answers', 'is not', null)
      .orderBy('created_at', 'desc')
      .top(limit)
      .execute();
    return rows.map((r) => ({
      score: r.score,
      answers: parse(r.answers),
      ref: r.ref,
      at: r.created_at as Date,
    }));
  }

  async insertResponse(v: Parameters<FeedbackTx['insertResponse']>[0]) {
    const id = randomUUID();
    await this.tx
      .insertInto('feedback_responses')
      .values({
        id,
        tenant_id: this.tenant,
        point_id: v.pointId,
        score: v.score,
        channel: v.channel,
        ref: v.ref ?? null,
        comment: null,
        edit_hash: v.editHash ?? null,
        answers: v.answers ? JSON.stringify(v.answers) : null,
      })
      .execute();
    return id;
  }

  async lockResponse(pointId: string, id: string) {
    const res = await ksql<Record<string, unknown>>`
      SELECT * FROM dbo.feedback_responses WITH (UPDLOCK, ROWLOCK)
      WHERE id = ${id} AND point_id = ${pointId}`.execute(this.tx);
    return res.rows[0] ? toResponse(res.rows[0]) : null;
  }

  async updateResponse(
    id: string,
    patch: { answers?: Record<string, unknown>; comment?: string; editHash: null },
  ) {
    await this.tx
      .updateTable('feedback_responses')
      .set({
        edit_hash: null,
        ...(patch.answers !== undefined ? { answers: JSON.stringify(patch.answers) } : {}),
        ...(patch.comment !== undefined ? { comment: patch.comment } : {}),
      })
      .where('id', '=', id)
      .execute();
  }
}

@Injectable()
export class MssqlFeedbackRepo implements FeedbackRepo {
  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: FeedbackTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) => fn(new MssqlFeedbackTx(tx, tenantId)));
  }

  ofSlug<T>(
    slug: string,
    fn: (t: FeedbackTx, found: { id: string; tenantId: string } | null) => Promise<T>,
  ) {
    return this.engine.sql.withTenantOf('feedback_point_by_slug', slug, (tx, found) =>
      fn(new MssqlFeedbackTx(tx, found?.tenantId ?? ''), found),
    );
  }
}

export const FEEDBACK_REPO = Symbol('FEEDBACK_REPO');
