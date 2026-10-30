import { Injectable } from '@nestjs/common';
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  max,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { sql as ksql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AuditService, type AuditEntry } from '../audit/audit.service.js';
import { AuditStore } from '../audit/audit-store.mssql.js';
import { Database, type Tx } from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import {
  auditLog,
  caseEvents,
  cases,
  invitations,
  libraryItems,
  openLinks,
  projects,
  questionnaireComments,
  questionnairePresence,
  questionnaireScenarios,
  questionnaireVersions,
  questionnaires,
  users,
  waves,
} from '../db/schema.js';
import { json, QuestionnaireStore } from './questionnaire-store.mssql.js';

/**
 * What the questionnaire, collaboration and library controllers need from the database,
 * whichever engine runs (the pattern of `auth/auth-repo.ts`): the PostgreSQL side is the Drizzle
 * code they had, the SQL Server side uses `QuestionnaireStore` and direct queries. Rows come out
 * in one shape (camelCase, lower-case ids), as Drizzle returned them.
 */
export interface QuestionnaireView {
  id: string;
  projectId: string;
  name: string;
  draft: Record<string, unknown>;
  draftRevision: number;
  updatedAt: Date;
  updatedBy: string | null;
  state: string;
  stateChangedAt: Date | null;
  successorId: string | null;
  createdAt: Date;
}

export interface VersionView {
  id: string;
  tenantId: string;
  questionnaireId: string;
  version: number;
  status: string;
  definition: unknown;
  compiled: unknown;
  hash: string;
  mapping: unknown;
  publishedBy: string | null;
  publishedAt: Date;
  retiredAt: Date | null;
}

export interface CommentView {
  id: string;
  tenantId: string;
  questionnaireId: string;
  itemId: string | null;
  parentId: string | null;
  authorId: string;
  body: string;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LibraryItemView {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  tags: string[];
  languages: string[];
  content: unknown;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuestionnairesTx {
  // ─── Questionnaires ─────────────────────────────────────────────────────────────────
  project(id: string): Promise<{ id: string; languages: string[]; modesEnabled: string[] } | null>;
  /** The project's questionnaires by name, each with its draft's modes (null: not set). */
  list(projectId: string): Promise<
    {
      id: string;
      name: string;
      draftRevision: number;
      updatedAt: Date;
      createdAt: Date;
      state: string;
      stateChangedAt: Date | null;
      successorId: string | null;
      modes: string[] | null;
    }[]
  >;
  /** Versions of these questionnaires, newest first. */
  versionsOf(
    ids: string[],
  ): Promise<{ questionnaireId: string; version: number; status: string; publishedAt: Date }[]>;
  /** The definition of one version of a questionnaire of the project. */
  versionDefinition(
    projectId: string,
    questionnaireId: string,
    version: number,
  ): Promise<Record<string, unknown> | null>;
  create(v: {
    projectId: string;
    name: string;
    draft: Record<string, unknown>;
    userId: string;
  }): Promise<string>;
  get(projectId: string, id: string): Promise<QuestionnaireView | null>;
  /** The same, with a row lock for the rest of the transaction. */
  lock(projectId: string, id: string): Promise<QuestionnaireView | null>;
  userName(id: string): Promise<string | null>;
  latestVersion(id: string): Promise<number | null>;
  rename(
    projectId: string,
    id: string,
    name: string,
    userId: string,
  ): Promise<{ id: string; name: string } | null>;
  /** Whether it was published or used for web surveys (a wave, an invitation, an open link). */
  inUse(id: string): Promise<boolean>;
  /** Deletes it with its scenarios, comments and presence. */
  remove(id: string): Promise<void>;
  saveDraft(
    id: string,
    v: { draft: Record<string, unknown>; revision: number; userId: string; name?: string },
  ): Promise<{ draftRevision: number; updatedAt: Date }>;
  /** Whether the person saved this draft since `since` (audit entries). */
  savedDraftSince(id: string, userId: string, since: Date): Promise<boolean>;
  versions(id: string): Promise<
    {
      version: number;
      status: string;
      hash: string;
      hasMapping: boolean;
      publishedAt: Date;
      publishedBy: string | null;
      retiredAt: Date | null;
    }[]
  >;
  version(id: string, version: number): Promise<VersionView | null>;
  /** The latest version, for the publish checks. */
  previous(id: string): Promise<{ version: number; definition: unknown; hash: string } | null>;
  publish(v: {
    questionnaireId: string;
    version: number;
    definition: unknown;
    compiled: { hash: string };
    mapping: unknown;
    userId: string;
  }): Promise<{ version: number; status: string; hash: string; publishedAt: Date }>;
  retire(
    id: string,
    version: number,
  ): Promise<{ version: number; status: string; retiredAt: Date | null } | null>;
  /** A questionnaire of the project (to continue web links in). */
  sibling(projectId: string, id: string): Promise<{ id: string; state: string } | null>;
  setState(
    id: string,
    state: string,
    successorId: string | null,
  ): Promise<{
    id: string;
    state: string;
    successorId: string | null;
    stateChangedAt: Date | null;
  }>;
  /** Closes the pending cases (FIELDWORK_CLOSED) and records it; returns how many. */
  closePendingCases(id: string, actorUserId: string): Promise<number>;
  scenarios(
    id: string,
  ): Promise<{ id: string; name: string; scenario: unknown; updatedAt: Date }[]>;
  saveScenario(v: {
    questionnaireId: string;
    name: string;
    scenario: unknown;
    userId: string;
  }): Promise<{ id: string; name: string; updatedAt: Date }>;
  deleteScenario(questionnaireId: string, id: string): Promise<string | null>;

  // ─── Review comments and presence ───────────────────────────────────────────────────
  comments(
    questionnaireId: string,
  ): Promise<
    (Pick<
      CommentView,
      'id' | 'itemId' | 'parentId' | 'authorId' | 'body' | 'resolvedAt' | 'createdAt'
    > & { authorName: string | null; resolvedByName: string | null })[]
  >;
  comment(questionnaireId: string, id: string): Promise<CommentView | null>;
  addComment(v: {
    questionnaireId: string;
    itemId: string | null;
    parentId: string | null;
    authorId: string;
    body: string;
  }): Promise<CommentView>;
  setResolved(id: string, by: string | null): Promise<CommentView>;
  hasReplies(id: string): Promise<boolean>;
  deleteComment(id: string): Promise<void>;
  touchPresence(questionnaireId: string, userId: string, itemId: string | null): Promise<void>;
  leavePresence(questionnaireId: string, userId: string): Promise<void>;
  /** Editors seen since `since`, by name. */
  editors(
    questionnaireId: string,
    since: Date,
  ): Promise<{ userId: string; name: string; itemId: string | null; lastSeen: Date }[]>;
  head(questionnaireId: string): Promise<{
    draftRevision: number;
    updatedAt: Date;
    updatedById: string | null;
    updatedBy: string | null;
  } | null>;

  // ─── Library ────────────────────────────────────────────────────────────────────────
  libraryList(q: { text?: string; tag?: string }): Promise<
    {
      id: string;
      name: string;
      description: string | null;
      tags: string[];
      languages: string[];
      content: unknown;
      createdBy: string | null;
      updatedAt: Date;
    }[]
  >;
  libraryCreate(v: {
    name: string;
    description: string | null;
    tags: string[];
    languages: string[];
    content: unknown;
    userId: string;
  }): Promise<LibraryItemView>;
  libraryUpdate(
    id: string,
    v: { name?: string; description?: string | null; tags?: string[] },
  ): Promise<LibraryItemView | null>;
  libraryDelete(id: string): Promise<{ id: string; name: string } | null>;

  audit(entry: AuditEntry): Promise<void>;
}

export interface QuestionnairesRepo {
  inTenant<T>(tenantId: string, fn: (t: QuestionnairesTx) => Promise<T>): Promise<T>;
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

class PgQuestionnairesTx implements QuestionnairesTx {
  constructor(
    private readonly tx: Tx,
    private readonly tenantId: string,
    private readonly audits: AuditService,
  ) {}

  async project(id: string) {
    const [p] = await this.tx
      .select({
        id: projects.id,
        languages: projects.languages,
        modesEnabled: projects.modesEnabled,
      })
      .from(projects)
      .where(eq(projects.id, id));
    return p ?? null;
  }

  list(projectId: string) {
    return this.tx
      .select({
        id: questionnaires.id,
        name: questionnaires.name,
        draftRevision: questionnaires.draftRevision,
        updatedAt: questionnaires.updatedAt,
        createdAt: questionnaires.createdAt,
        state: questionnaires.state,
        stateChangedAt: questionnaires.stateChangedAt,
        successorId: questionnaires.successorId,
        modes: sql<string[] | null>`${questionnaires.draft} -> 'modes'`,
      })
      .from(questionnaires)
      .where(eq(questionnaires.projectId, projectId))
      .orderBy(questionnaires.name);
  }

  async versionsOf(ids: string[]) {
    if (!ids.length) return [];
    return this.tx
      .select({
        questionnaireId: questionnaireVersions.questionnaireId,
        version: questionnaireVersions.version,
        status: questionnaireVersions.status,
        publishedAt: questionnaireVersions.publishedAt,
      })
      .from(questionnaireVersions)
      .where(inArray(questionnaireVersions.questionnaireId, ids))
      .orderBy(desc(questionnaireVersions.version));
  }

  async versionDefinition(projectId: string, questionnaireId: string, version: number) {
    const [v] = await this.tx
      .select({ definition: questionnaireVersions.definition })
      .from(questionnaireVersions)
      .innerJoin(questionnaires, eq(questionnaires.id, questionnaireVersions.questionnaireId))
      .where(
        and(
          eq(questionnaireVersions.questionnaireId, questionnaireId),
          eq(questionnaireVersions.version, version),
          eq(questionnaires.projectId, projectId),
        ),
      );
    return v ? (v.definition as Record<string, unknown>) : null;
  }

  async create(v: {
    projectId: string;
    name: string;
    draft: Record<string, unknown>;
    userId: string;
  }) {
    const [row] = await this.tx
      .insert(questionnaires)
      .values({
        tenantId: this.tenantId,
        projectId: v.projectId,
        name: v.name,
        draft: v.draft,
        updatedBy: v.userId,
      })
      .returning({ id: questionnaires.id });
    return row!.id;
  }

  async get(projectId: string, id: string) {
    const [q] = await this.tx
      .select()
      .from(questionnaires)
      .where(and(eq(questionnaires.id, id), eq(questionnaires.projectId, projectId)));
    return (q as QuestionnaireView | undefined) ?? null;
  }

  async lock(projectId: string, id: string) {
    const [q] = await this.tx
      .select()
      .from(questionnaires)
      .where(and(eq(questionnaires.id, id), eq(questionnaires.projectId, projectId)))
      .for('update');
    return (q as QuestionnaireView | undefined) ?? null;
  }

  async userName(id: string) {
    const [u] = await this.tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? null;
  }

  async latestVersion(id: string) {
    const [latest] = await this.tx
      .select({ version: max(questionnaireVersions.version) })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.questionnaireId, id));
    return latest?.version ?? null;
  }

  async rename(projectId: string, id: string, name: string, userId: string) {
    const [row] = await this.tx
      .update(questionnaires)
      .set({ name, updatedAt: new Date(), updatedBy: userId })
      .where(and(eq(questionnaires.id, id), eq(questionnaires.projectId, projectId)))
      .returning({ id: questionnaires.id, name: questionnaires.name });
    return row ?? null;
  }

  async inUse(id: string) {
    const used = async (table: typeof waves | typeof invitations | typeof openLinks) =>
      (
        await this.tx
          .select({ n: sql<number>`count(*)::int` })
          .from(table)
          .where(eq(table.questionnaireId, id))
      )[0]!.n > 0;
    const [versions] = await this.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.questionnaireId, id));
    return (
      versions!.n > 0 || (await used(waves)) || (await used(invitations)) || (await used(openLinks))
    );
  }

  async remove(id: string) {
    await this.tx
      .delete(questionnaireScenarios)
      .where(eq(questionnaireScenarios.questionnaireId, id));
    await this.tx
      .delete(questionnaireComments)
      .where(eq(questionnaireComments.questionnaireId, id));
    await this.tx
      .delete(questionnairePresence)
      .where(eq(questionnairePresence.questionnaireId, id));
    await this.tx.delete(questionnaires).where(eq(questionnaires.id, id));
  }

  async saveDraft(
    id: string,
    v: { draft: Record<string, unknown>; revision: number; userId: string; name?: string },
  ) {
    const [row] = await this.tx
      .update(questionnaires)
      .set({
        draft: v.draft,
        draftRevision: v.revision,
        updatedBy: v.userId,
        updatedAt: new Date(),
        ...(v.name ? { name: v.name } : {}),
      })
      .where(eq(questionnaires.id, id))
      .returning({
        draftRevision: questionnaires.draftRevision,
        updatedAt: questionnaires.updatedAt,
      });
    return row!;
  }

  async savedDraftSince(id: string, userId: string, since: Date) {
    const [recent] = await this.tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'questionnaire.draft_saved'),
          eq(auditLog.targetId, id),
          eq(auditLog.actorUserId, userId),
          gte(auditLog.at, since),
        ),
      )
      .limit(1);
    return !!recent;
  }

  versions(id: string) {
    return this.tx
      .select({
        version: questionnaireVersions.version,
        status: questionnaireVersions.status,
        hash: questionnaireVersions.hash,
        hasMapping: sql<boolean>`${questionnaireVersions.mapping} is not null`,
        publishedAt: questionnaireVersions.publishedAt,
        publishedBy: users.name,
        retiredAt: questionnaireVersions.retiredAt,
      })
      .from(questionnaireVersions)
      .leftJoin(users, eq(users.id, questionnaireVersions.publishedBy))
      .where(eq(questionnaireVersions.questionnaireId, id))
      .orderBy(desc(questionnaireVersions.version));
  }

  async version(id: string, version: number) {
    const [v] = await this.tx
      .select()
      .from(questionnaireVersions)
      .where(
        and(
          eq(questionnaireVersions.questionnaireId, id),
          eq(questionnaireVersions.version, version),
        ),
      );
    return (v as VersionView | undefined) ?? null;
  }

  async previous(id: string) {
    const [v] = await this.tx
      .select({
        version: questionnaireVersions.version,
        definition: questionnaireVersions.definition,
        hash: questionnaireVersions.hash,
      })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.questionnaireId, id))
      .orderBy(desc(questionnaireVersions.version))
      .limit(1);
    return v ?? null;
  }

  async publish(v: Parameters<QuestionnairesTx['publish']>[0]) {
    const [row] = await this.tx
      .insert(questionnaireVersions)
      .values({
        tenantId: this.tenantId,
        questionnaireId: v.questionnaireId,
        version: v.version,
        definition: v.definition,
        compiled: v.compiled,
        hash: v.compiled.hash,
        mapping: v.mapping ?? null,
        publishedBy: v.userId,
      })
      .returning({
        version: questionnaireVersions.version,
        status: questionnaireVersions.status,
        hash: questionnaireVersions.hash,
        publishedAt: questionnaireVersions.publishedAt,
      });
    return row!;
  }

  async retire(id: string, version: number) {
    const [row] = await this.tx
      .update(questionnaireVersions)
      .set({ status: 'retired', retiredAt: new Date() })
      .where(
        and(
          eq(questionnaireVersions.questionnaireId, id),
          eq(questionnaireVersions.version, version),
          eq(questionnaireVersions.status, 'published'),
        ),
      )
      .returning({
        version: questionnaireVersions.version,
        status: questionnaireVersions.status,
        retiredAt: questionnaireVersions.retiredAt,
      });
    return row ?? null;
  }

  async sibling(projectId: string, id: string) {
    const [next] = await this.tx
      .select({ id: questionnaires.id, state: questionnaires.state })
      .from(questionnaires)
      .where(and(eq(questionnaires.id, id), eq(questionnaires.projectId, projectId)));
    return next ?? null;
  }

  async setState(id: string, state: string, successorId: string | null) {
    const [row] = await this.tx
      .update(questionnaires)
      .set({ state, successorId, stateChangedAt: new Date() })
      .where(eq(questionnaires.id, id))
      .returning({
        id: questionnaires.id,
        state: questionnaires.state,
        successorId: questionnaires.successorId,
        stateChangedAt: questionnaires.stateChangedAt,
      });
    return row!;
  }

  async closePendingCases(id: string, actorUserId: string) {
    const done = await this.tx
      .update(cases)
      .set({
        status: 'finalised',
        disposition: 'FIELDWORK_CLOSED',
        nextContactAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(cases.questionnaireId, id),
          inArray(cases.status, ['fresh', 'assigned']),
          isNull(cases.checkedOutDevice),
          sql`not exists (select 1 from interviews iv where iv.case_id = ${cases.id}
                and iv.status = 'in_progress')`,
        ),
      )
      .returning({ id: cases.id });
    if (done.length)
      await this.tx.insert(caseEvents).values(
        done.map((c) => ({
          tenantId: this.tenantId,
          caseId: c.id,
          actorUserId,
          type: 'closed',
          details: { questionnaireId: id, reason: 'questionnaire_completed' },
        })),
      );
    return done.length;
  }

  scenarios(id: string) {
    return this.tx
      .select({
        id: questionnaireScenarios.id,
        name: questionnaireScenarios.name,
        scenario: questionnaireScenarios.scenario,
        updatedAt: questionnaireScenarios.updatedAt,
      })
      .from(questionnaireScenarios)
      .where(eq(questionnaireScenarios.questionnaireId, id))
      .orderBy(questionnaireScenarios.name);
  }

  async saveScenario(v: {
    questionnaireId: string;
    name: string;
    scenario: unknown;
    userId: string;
  }) {
    const [row] = await this.tx
      .insert(questionnaireScenarios)
      .values({
        tenantId: this.tenantId,
        questionnaireId: v.questionnaireId,
        name: v.name,
        scenario: v.scenario,
        createdBy: v.userId,
      })
      .onConflictDoUpdate({
        target: [questionnaireScenarios.questionnaireId, questionnaireScenarios.name],
        set: { scenario: v.scenario, updatedAt: new Date() },
      })
      .returning({
        id: questionnaireScenarios.id,
        name: questionnaireScenarios.name,
        updatedAt: questionnaireScenarios.updatedAt,
      });
    return row!;
  }

  async deleteScenario(questionnaireId: string, id: string) {
    const [row] = await this.tx
      .delete(questionnaireScenarios)
      .where(
        and(
          eq(questionnaireScenarios.id, id),
          eq(questionnaireScenarios.questionnaireId, questionnaireId),
        ),
      )
      .returning({ name: questionnaireScenarios.name });
    return row?.name ?? null;
  }

  async comments(questionnaireId: string) {
    const author = alias(users, 'author');
    const resolver = alias(users, 'resolver');
    return this.tx
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
      .where(eq(questionnaireComments.questionnaireId, questionnaireId))
      .orderBy(asc(questionnaireComments.createdAt));
  }

  async comment(questionnaireId: string, id: string) {
    const [c] = await this.tx
      .select()
      .from(questionnaireComments)
      .where(
        and(
          eq(questionnaireComments.id, id),
          eq(questionnaireComments.questionnaireId, questionnaireId),
        ),
      );
    return c ?? null;
  }

  async addComment(v: {
    questionnaireId: string;
    itemId: string | null;
    parentId: string | null;
    authorId: string;
    body: string;
  }) {
    const [row] = await this.tx
      .insert(questionnaireComments)
      .values({ tenantId: this.tenantId, ...v })
      .returning();
    return row!;
  }

  async setResolved(id: string, by: string | null) {
    const [row] = await this.tx
      .update(questionnaireComments)
      .set({
        resolvedAt: by ? new Date() : null,
        resolvedBy: by,
        updatedAt: new Date(),
      })
      .where(eq(questionnaireComments.id, id))
      .returning();
    return row!;
  }

  async hasReplies(id: string) {
    const [reply] = await this.tx
      .select({ id: questionnaireComments.id })
      .from(questionnaireComments)
      .where(eq(questionnaireComments.parentId, id))
      .limit(1);
    return !!reply;
  }

  async deleteComment(id: string) {
    await this.tx.delete(questionnaireComments).where(eq(questionnaireComments.id, id));
  }

  async touchPresence(questionnaireId: string, userId: string, itemId: string | null) {
    await this.tx
      .insert(questionnairePresence)
      .values({ tenantId: this.tenantId, questionnaireId, userId, itemId })
      .onConflictDoUpdate({
        target: [questionnairePresence.questionnaireId, questionnairePresence.userId],
        set: { itemId, lastSeen: sql`now()` },
      });
  }

  async leavePresence(questionnaireId: string, userId: string) {
    await this.tx
      .delete(questionnairePresence)
      .where(
        and(
          eq(questionnairePresence.questionnaireId, questionnaireId),
          eq(questionnairePresence.userId, userId),
        ),
      );
  }

  editors(questionnaireId: string, since: Date) {
    return this.tx
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
          eq(questionnairePresence.questionnaireId, questionnaireId),
          gte(questionnairePresence.lastSeen, since),
        ),
      )
      .orderBy(asc(users.name));
  }

  async head(questionnaireId: string) {
    const [head] = await this.tx
      .select({
        draftRevision: questionnaires.draftRevision,
        updatedAt: questionnaires.updatedAt,
        updatedById: questionnaires.updatedBy,
        updatedBy: users.name,
      })
      .from(questionnaires)
      .leftJoin(users, eq(users.id, questionnaires.updatedBy))
      .where(eq(questionnaires.id, questionnaireId));
    return head ?? null;
  }

  libraryList(q: { text?: string; tag?: string }) {
    const conds: SQL[] = [];
    if (q.text) {
      const term = `%${q.text.replace(/[%_\\]/g, '\\$&')}%`;
      conds.push(or(ilike(libraryItems.name, term), ilike(libraryItems.description, term))!);
    }
    if (q.tag) conds.push(arrayContains(libraryItems.tags, [q.tag]));
    return this.tx
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
  }

  async libraryCreate(v: Parameters<QuestionnairesTx['libraryCreate']>[0]) {
    const [row] = await this.tx
      .insert(libraryItems)
      .values({
        tenantId: this.tenantId,
        name: v.name,
        description: v.description,
        tags: v.tags,
        languages: v.languages,
        content: v.content,
        createdBy: v.userId,
      })
      .returning();
    return row as LibraryItemView;
  }

  async libraryUpdate(
    id: string,
    v: { name?: string; description?: string | null; tags?: string[] },
  ) {
    const [row] = await this.tx
      .update(libraryItems)
      .set({ ...v, updatedAt: new Date() })
      .where(eq(libraryItems.id, id))
      .returning();
    return (row as LibraryItemView | undefined) ?? null;
  }

  async libraryDelete(id: string) {
    const [row] = await this.tx
      .delete(libraryItems)
      .where(eq(libraryItems.id, id))
      .returning({ id: libraryItems.id, name: libraryItems.name });
    return row ?? null;
  }

  audit(entry: AuditEntry) {
    return this.audits.record(this.tx, this.tenantId, entry);
  }
}

@Injectable()
export class PgQuestionnairesRepo implements QuestionnairesRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  inTenant<T>(tenantId: string, fn: (t: QuestionnairesTx) => Promise<T>) {
    return this.database.withTenant(tenantId, (tx) =>
      fn(new PgQuestionnairesTx(tx, tenantId, this.audits)),
    );
  }
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const lowOrNull = (s: string | null) => (s === null ? null : s.toLowerCase());

class MssqlQuestionnairesTx implements QuestionnairesTx {
  constructor(
    private readonly tx: MssqlTx,
    private readonly tenantId: string,
    private readonly store: QuestionnaireStore,
    private readonly auditStore: AuditStore,
  ) {}

  private view(r: {
    id: string;
    project_id: string;
    name: string;
    draft: Record<string, unknown>;
    draft_revision: number;
    updated_at: Date;
    updated_by: string | null;
    state: string;
    state_changed_at: Date | null;
    successor_id: string | null;
    created_at: Date;
  }): QuestionnaireView {
    return {
      id: low(r.id),
      projectId: low(r.project_id),
      name: r.name,
      draft: r.draft,
      draftRevision: r.draft_revision,
      updatedAt: r.updated_at,
      updatedBy: lowOrNull(r.updated_by),
      state: r.state,
      stateChangedAt: r.state_changed_at,
      successorId: lowOrNull(r.successor_id),
      createdAt: r.created_at,
    };
  }

  async project(id: string) {
    const p = await this.tx
      .selectFrom('projects')
      .select(['id', 'languages', 'modes_enabled'])
      .where('id', '=', id)
      .executeTakeFirst();
    return p
      ? {
          id: low(p.id),
          languages: json<string[]>(p.languages),
          modesEnabled: json<string[]>(p.modes_enabled),
        }
      : null;
  }

  async list(projectId: string) {
    const rows = await this.tx
      .selectFrom('questionnaires')
      .select([
        'id',
        'name',
        'draft_revision',
        'updated_at',
        'created_at',
        'state',
        'state_changed_at',
        'successor_id',
        // The draft is large: only its modes are read.
        ksql<string | null>`CASE WHEN ISJSON(draft) = 1 THEN JSON_QUERY(draft, '$.modes') END`.as(
          'modes',
        ),
      ])
      .where('project_id', '=', projectId)
      .orderBy('name')
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      name: r.name,
      draftRevision: r.draft_revision,
      updatedAt: r.updated_at,
      createdAt: r.created_at,
      state: r.state,
      stateChangedAt: r.state_changed_at,
      successorId: lowOrNull(r.successor_id),
      modes: r.modes ? json<string[]>(r.modes) : null,
    }));
  }

  async versionsOf(ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.tx
      .selectFrom('questionnaire_versions')
      .select(['questionnaire_id', 'version', 'status', 'published_at'])
      .where('questionnaire_id', 'in', ids)
      .orderBy('version', 'desc')
      .execute();
    return rows.map((r) => ({
      questionnaireId: low(r.questionnaire_id),
      version: r.version,
      status: r.status,
      publishedAt: r.published_at,
    }));
  }

  async versionDefinition(projectId: string, questionnaireId: string, version: number) {
    const v = await this.tx
      .selectFrom('questionnaire_versions as v')
      .innerJoin('questionnaires as q', 'q.id', 'v.questionnaire_id')
      .select('v.definition')
      .where('v.questionnaire_id', '=', questionnaireId)
      .where('v.version', '=', version)
      .where('q.project_id', '=', projectId)
      .executeTakeFirst();
    return v ? json<Record<string, unknown>>(v.definition) : null;
  }

  create(v: { projectId: string; name: string; draft: Record<string, unknown>; userId: string }) {
    return this.store.create(this.tx, { tenantId: this.tenantId, ...v });
  }

  async get(projectId: string, id: string) {
    const q = await this.store.get(this.tx, projectId, id);
    return q ? this.view(q) : null;
  }

  async lock(projectId: string, id: string) {
    const q = await this.store.lockDraft(this.tx, projectId, id);
    return q ? this.view(q) : null;
  }

  async userName(id: string) {
    const u = await this.tx
      .selectFrom('users')
      .select('name')
      .where('id', '=', id)
      .executeTakeFirst();
    return u?.name ?? null;
  }

  async latestVersion(id: string) {
    return (await this.store.latestVersion(this.tx, id))?.version ?? null;
  }

  async rename(projectId: string, id: string, name: string, userId: string) {
    if (!(await this.store.get(this.tx, projectId, id))) return null;
    await this.store.rename(this.tx, id, name, userId);
    return { id: low(id), name };
  }

  async inUse(id: string) {
    const count = async (
      table: 'questionnaire_versions' | 'waves' | 'invitations' | 'open_links',
    ) =>
      (
        await this.tx
          .selectFrom(table)
          .select(ksql<number>`count(*)`.as('n'))
          .where('questionnaire_id', '=', id)
          .executeTakeFirstOrThrow()
      ).n > 0;
    return (
      (await count('questionnaire_versions')) ||
      (await count('waves')) ||
      (await count('invitations')) ||
      (await count('open_links'))
    );
  }

  remove(id: string) {
    return this.store.deleteUnpublished(this.tx, id);
  }

  saveDraft(
    id: string,
    v: { draft: Record<string, unknown>; revision: number; userId: string; name?: string },
  ) {
    // The row is locked by the caller; `revision` is the one it read plus one.
    return this.store.saveDraft(this.tx, id, {
      baseRevision: v.revision - 1,
      draft: v.draft,
      userId: v.userId,
      name: v.name,
    });
  }

  async savedDraftSince(id: string, userId: string, since: Date) {
    const r = await this.tx
      .selectFrom('audit_log')
      .select('id')
      .where('action', '=', 'questionnaire.draft_saved')
      .where('target_id', '=', id)
      .where('actor_user_id', '=', userId)
      .where('at', '>=', instant(since))
      .top(1)
      .executeTakeFirst();
    return !!r;
  }

  async versions(id: string) {
    const rows = await this.tx
      .selectFrom('questionnaire_versions as v')
      .leftJoin('users as u', 'u.id', 'v.published_by')
      .select([
        'v.version',
        'v.status',
        'v.hash',
        ksql<boolean>`CASE WHEN v.mapping IS NOT NULL THEN 1 ELSE 0 END`.as('has_mapping'),
        'v.published_at',
        'u.name as published_by',
        'v.retired_at',
      ])
      .where('v.questionnaire_id', '=', id)
      .orderBy('v.version', 'desc')
      .execute();
    return rows.map((r) => ({
      version: r.version,
      status: r.status,
      hash: r.hash,
      hasMapping: !!r.has_mapping,
      publishedAt: r.published_at,
      publishedBy: r.published_by,
      retiredAt: r.retired_at,
    }));
  }

  async version(id: string, version: number) {
    const r = await this.tx
      .selectFrom('questionnaire_versions')
      .selectAll()
      .where('questionnaire_id', '=', id)
      .where('version', '=', version)
      .executeTakeFirst();
    return r
      ? {
          id: low(r.id),
          tenantId: low(r.tenant_id),
          questionnaireId: low(r.questionnaire_id),
          version: r.version,
          status: r.status,
          definition: json(r.definition),
          compiled: json(r.compiled),
          hash: r.hash,
          mapping: json(r.mapping),
          publishedBy: lowOrNull(r.published_by),
          publishedAt: r.published_at,
          retiredAt: r.retired_at,
        }
      : null;
  }

  async previous(id: string) {
    const v = await this.store.latestVersion(this.tx, id);
    return v ? { version: v.version, definition: v.definition, hash: v.hash } : null;
  }

  publish(v: Parameters<QuestionnairesTx['publish']>[0]) {
    return this.store.publish(this.tx, {
      tenantId: this.tenantId,
      questionnaireId: v.questionnaireId,
      definition: v.definition,
      compiled: v.compiled,
      mapping: v.mapping,
      userId: v.userId,
    });
  }

  async retire(id: string, version: number) {
    const res = await this.tx
      .updateTable('questionnaire_versions')
      .set({ status: 'retired', retired_at: ksql<Date>`SYSDATETIMEOFFSET()` })
      .where('questionnaire_id', '=', id)
      .where('version', '=', version)
      .where('status', '=', 'published')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return null;
    const r = await this.tx
      .selectFrom('questionnaire_versions')
      .select(['version', 'status', 'retired_at'])
      .where('questionnaire_id', '=', id)
      .where('version', '=', version)
      .executeTakeFirstOrThrow();
    return { version: r.version, status: r.status, retiredAt: r.retired_at };
  }

  async sibling(projectId: string, id: string) {
    const q = await this.tx
      .selectFrom('questionnaires')
      .select(['id', 'state'])
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return q ? { id: low(q.id), state: q.state } : null;
  }

  async setState(id: string, state: string, successorId: string | null) {
    await this.store.setState(
      this.tx,
      id,
      state as 'active' | 'disabled' | 'completed',
      successorId,
    );
    const r = await this.tx
      .selectFrom('questionnaires')
      .select(['id', 'state', 'successor_id', 'state_changed_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return {
      id: low(r.id),
      state: r.state,
      successorId: lowOrNull(r.successor_id),
      stateChangedAt: r.state_changed_at,
    };
  }

  async closePendingCases(id: string, actorUserId: string) {
    const res = await ksql<{ id: string }>`
      UPDATE c SET status = 'finalised', disposition = 'FIELDWORK_CLOSED',
                   next_contact_at = NULL, updated_at = SYSDATETIMEOFFSET()
      OUTPUT inserted.id
      FROM dbo.cases c
      WHERE c.questionnaire_id = ${id} AND c.status IN ('fresh', 'assigned')
        AND c.checked_out_device IS NULL
        AND NOT EXISTS (SELECT 1 FROM dbo.interviews iv
                        WHERE iv.case_id = c.id AND iv.status = 'in_progress')`.execute(this.tx);
    if (res.rows.length)
      await this.tx
        .insertInto('case_events')
        .values(
          res.rows.map((c) => ({
            id: randomUUID(),
            tenant_id: this.tenantId,
            case_id: c.id,
            actor_user_id: actorUserId,
            type: 'closed',
            details: JSON.stringify({ questionnaireId: id, reason: 'questionnaire_completed' }),
          })),
        )
        .execute();
    return res.rows.length;
  }

  async scenarios(id: string) {
    return (await this.store.scenarios(this.tx, id)).map((r) => ({
      id: low(r.id),
      name: r.name,
      scenario: r.scenario,
      updatedAt: r.updated_at,
    }));
  }

  async saveScenario(v: {
    questionnaireId: string;
    name: string;
    scenario: unknown;
    userId: string;
  }) {
    await this.store.saveScenario(this.tx, { tenantId: this.tenantId, ...v });
    const r = await this.tx
      .selectFrom('questionnaire_scenarios')
      .select(['id', 'name', 'updated_at'])
      .where('questionnaire_id', '=', v.questionnaireId)
      .where('name', '=', v.name)
      .executeTakeFirstOrThrow();
    return { id: low(r.id), name: r.name, updatedAt: r.updated_at };
  }

  async deleteScenario(questionnaireId: string, id: string) {
    const r = await this.tx
      .selectFrom('questionnaire_scenarios')
      .select('name')
      .where('questionnaire_id', '=', questionnaireId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) return null;
    await this.store.deleteScenario(this.tx, questionnaireId, id);
    return r.name;
  }

  async comments(questionnaireId: string) {
    const rows = await this.tx
      .selectFrom('questionnaire_comments as c')
      .leftJoin('users as a', 'a.id', 'c.author_id')
      .leftJoin('users as r', 'r.id', 'c.resolved_by')
      .select([
        'c.id',
        'c.item_id',
        'c.parent_id',
        'c.author_id',
        'a.name as author_name',
        'c.body',
        'c.resolved_at',
        'r.name as resolved_by_name',
        'c.created_at',
      ])
      .where('c.questionnaire_id', '=', questionnaireId)
      .orderBy('c.created_at')
      .orderBy('c.id')
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      itemId: r.item_id,
      parentId: lowOrNull(r.parent_id),
      authorId: low(r.author_id),
      authorName: r.author_name,
      body: r.body,
      resolvedAt: r.resolved_at,
      resolvedByName: r.resolved_by_name,
      createdAt: r.created_at,
    }));
  }

  private comm(r: {
    id: string;
    tenant_id: string;
    questionnaire_id: string;
    item_id: string | null;
    parent_id: string | null;
    author_id: string;
    body: string;
    resolved_at: Date | null;
    resolved_by: string | null;
    created_at: Date;
    updated_at: Date;
  }): CommentView {
    return {
      id: low(r.id),
      tenantId: low(r.tenant_id),
      questionnaireId: low(r.questionnaire_id),
      itemId: r.item_id,
      parentId: lowOrNull(r.parent_id),
      authorId: low(r.author_id),
      body: r.body,
      resolvedAt: r.resolved_at,
      resolvedBy: lowOrNull(r.resolved_by),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async comment(questionnaireId: string, id: string) {
    const r = await this.tx
      .selectFrom('questionnaire_comments')
      .selectAll()
      .where('id', '=', id)
      .where('questionnaire_id', '=', questionnaireId)
      .executeTakeFirst();
    return r ? this.comm(r) : null;
  }

  async addComment(v: {
    questionnaireId: string;
    itemId: string | null;
    parentId: string | null;
    authorId: string;
    body: string;
  }) {
    const id = await this.store.addComment(this.tx, { tenantId: this.tenantId, ...v });
    return (await this.comment(v.questionnaireId, id))!;
  }

  async setResolved(id: string, by: string | null) {
    await this.store.resolveThread(this.tx, id, by ?? '', !!by);
    const r = await this.tx
      .selectFrom('questionnaire_comments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return this.comm(r);
  }

  async hasReplies(id: string) {
    const r = await this.tx
      .selectFrom('questionnaire_comments')
      .select('id')
      .where('parent_id', '=', id)
      .top(1)
      .executeTakeFirst();
    return !!r;
  }

  async deleteComment(id: string) {
    await this.tx.deleteFrom('questionnaire_comments').where('id', '=', id).execute();
  }

  touchPresence(questionnaireId: string, userId: string, itemId: string | null) {
    return this.store.touchPresence(this.tx, {
      tenantId: this.tenantId,
      questionnaireId,
      userId,
      itemId,
    });
  }

  async leavePresence(questionnaireId: string, userId: string) {
    await this.tx
      .deleteFrom('questionnaire_presence')
      .where('questionnaire_id', '=', questionnaireId)
      .where('user_id', '=', userId)
      .execute();
  }

  async editors(questionnaireId: string, since: Date) {
    const rows = await this.tx
      .selectFrom('questionnaire_presence as p')
      .innerJoin('users as u', 'u.id', 'p.user_id')
      .select(['p.user_id', 'u.name', 'p.item_id', 'p.last_seen'])
      .where('p.questionnaire_id', '=', questionnaireId)
      .where('p.last_seen', '>=', instant(since))
      .orderBy('u.name')
      .execute();
    return rows.map((r) => ({
      userId: low(r.user_id),
      name: r.name,
      itemId: r.item_id,
      lastSeen: r.last_seen,
    }));
  }

  async head(questionnaireId: string) {
    const r = await this.tx
      .selectFrom('questionnaires as q')
      .leftJoin('users as u', 'u.id', 'q.updated_by')
      .select(['q.draft_revision', 'q.updated_at', 'q.updated_by', 'u.name'])
      .where('q.id', '=', questionnaireId)
      .executeTakeFirst();
    return r
      ? {
          draftRevision: r.draft_revision,
          updatedAt: r.updated_at,
          updatedById: lowOrNull(r.updated_by),
          updatedBy: r.name,
        }
      : null;
  }

  async libraryList(q: { text?: string; tag?: string }) {
    let query = this.tx
      .selectFrom('library_items as l')
      .leftJoin('users as u', 'u.id', 'l.created_by')
      .select([
        'l.id',
        'l.name',
        'l.description',
        'l.tags',
        'l.languages',
        'l.content',
        'u.name as created_by',
        'l.updated_at',
      ]);
    if (q.text) {
      const term = `%${q.text.replace(/[%_[]/g, '[$&]')}%`;
      query = query.where((eb) =>
        eb.or([eb('l.name', 'like', term), eb('l.description', 'like', term)]),
      );
    }
    if (q.tag)
      query = query.where(
        ksql<boolean>`EXISTS (SELECT 1 FROM OPENJSON(l.tags) WHERE [value] = ${q.tag})`,
      );
    const rows = await query.orderBy('l.name').top(200).execute();
    return rows.map((r) => ({
      id: low(r.id),
      name: r.name,
      description: r.description,
      tags: json<string[]>(r.tags),
      languages: json<string[]>(r.languages),
      content: json(r.content),
      createdBy: r.created_by,
      updatedAt: r.updated_at,
    }));
  }

  private async libraryRow(id: string): Promise<LibraryItemView | null> {
    const r = await this.tx
      .selectFrom('library_items')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r
      ? {
          id: low(r.id),
          tenantId: low(r.tenant_id),
          name: r.name,
          description: r.description,
          tags: json<string[]>(r.tags),
          languages: json<string[]>(r.languages),
          content: json(r.content),
          createdBy: lowOrNull(r.created_by),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }
      : null;
  }

  async libraryCreate(v: Parameters<QuestionnairesTx['libraryCreate']>[0]) {
    const id = await this.store.saveLibraryItem(this.tx, { tenantId: this.tenantId, ...v });
    return (await this.libraryRow(id))!;
  }

  async libraryUpdate(
    id: string,
    v: { name?: string; description?: string | null; tags?: string[] },
  ) {
    const res = await this.tx
      .updateTable('library_items')
      .set({
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.description !== undefined ? { description: v.description } : {}),
        ...(v.tags !== undefined ? { tags: JSON.stringify(v.tags) } : {}),
        updated_at: ksql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(res.numUpdatedRows) === 0 ? null : this.libraryRow(id);
  }

  async libraryDelete(id: string) {
    const r = await this.libraryRow(id);
    if (!r) return null;
    await this.store.deleteLibraryItem(this.tx, id);
    return { id: r.id, name: r.name };
  }

  audit(entry: AuditEntry) {
    return this.auditStore.record(this.tx, this.tenantId, entry);
  }
}

@Injectable()
export class MssqlQuestionnairesRepo implements QuestionnairesRepo {
  private readonly store = new QuestionnaireStore();
  private readonly auditStore = new AuditStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: QuestionnairesTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlQuestionnairesTx(tx, tenantId, this.store, this.auditStore)),
    );
  }
}

export const QUESTIONNAIRES_REPO = Symbol('QUESTIONNAIRES_REPO');
