import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';
import type { MssqlSchema } from '../db/mssql/schema.js';

/**
 * The questionnaire vertical's data access on SQL Server (Kysely): the same operations the
 * controller runs on PostgreSQL with Drizzle, as a store the controller will call at the switch
 * (docs/roadmap.md). Every method takes the transaction of `MssqlDatabase.withTenant`, so the
 * security policy filters by organisation. JSON columns are JSON text: written with
 * JSON.stringify and read with `json`.
 */
export type QuestionnaireRow = Omit<Selectable<MssqlSchema['questionnaires']>, 'draft'> & {
  draft: Record<string, unknown>;
};
export type VersionRow = Omit<
  Selectable<MssqlSchema['questionnaire_versions']>,
  'definition' | 'compiled' | 'mapping'
> & { definition: Record<string, unknown>; compiled: Record<string, unknown>; mapping: unknown };

export const json = <T = unknown>(text: string | null): T =>
  text === null ? (null as T) : JSON.parse(text);

/** The draft was changed by someone else since `baseRevision` was read. */
export class DraftConflict extends Error {
  constructor(readonly current: { draftRevision: number; updatedBy: string | null }) {
    super('The draft changed since it was read');
  }
}

const toQuestionnaire = (r: Selectable<MssqlSchema['questionnaires']>): QuestionnaireRow => ({
  ...r,
  draft: json(r.draft),
});

const toVersion = (r: Selectable<MssqlSchema['questionnaire_versions']>): VersionRow => ({
  ...r,
  definition: json(r.definition),
  compiled: json(r.compiled),
  mapping: json(r.mapping),
});

export class QuestionnaireStore {
  async create(
    tx: MssqlTx,
    v: { tenantId: string; projectId: string; name: string; draft: unknown; userId: string | null },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('questionnaires')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        name: v.name,
        draft: JSON.stringify(v.draft),
        updated_by: v.userId,
        state_changed_at: null,
        successor_id: null,
      })
      .execute();
    return id;
  }

  async get(tx: MssqlTx, projectId: string, id: string): Promise<QuestionnaireRow | undefined> {
    const r = await tx
      .selectFrom('questionnaires')
      .selectAll()
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return r && toQuestionnaire(r);
  }

  async list(tx: MssqlTx, projectId: string) {
    return tx
      .selectFrom('questionnaires')
      .select(['id', 'name', 'state', 'draft_revision', 'updated_at', 'created_at'])
      .where('project_id', '=', projectId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /** Row lock for the rest of the transaction: saves and publishes of one questionnaire queue up. */
  async lockDraft(
    tx: MssqlTx,
    projectId: string,
    id: string,
  ): Promise<QuestionnaireRow | undefined> {
    const res = await sql<Selectable<MssqlSchema['questionnaires']>>`
      SELECT * FROM dbo.questionnaires WITH (UPDLOCK, ROWLOCK)
      WHERE id = ${id} AND project_id = ${projectId}`.execute(tx);
    const r = res.rows[0];
    return r && toQuestionnaire({ ...r, id: r.id.toLowerCase() });
  }

  /**
   * Saves the draft if it is still at `baseRevision` (compare and swap in one statement, so it is
   * safe even without the lock). Returns the new revision.
   */
  async saveDraft(
    tx: MssqlTx,
    id: string,
    v: { baseRevision: number; draft: unknown; userId: string | null; name?: string },
  ): Promise<{ draftRevision: number; updatedAt: Date }> {
    const res = await tx
      .updateTable('questionnaires')
      .set({
        draft: JSON.stringify(v.draft),
        draft_revision: sql<number>`draft_revision + 1`,
        updated_by: v.userId,
        updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
        ...(v.name ? { name: v.name } : {}),
      })
      .where('id', '=', id)
      .where('draft_revision', '=', v.baseRevision)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) {
      const cur = await tx
        .selectFrom('questionnaires')
        .select(['draft_revision', 'updated_by'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      throw new DraftConflict({ draftRevision: cur.draft_revision, updatedBy: cur.updated_by });
    }
    const row = await tx
      .selectFrom('questionnaires')
      .select(['draft_revision', 'updated_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { draftRevision: row.draft_revision, updatedAt: row.updated_at };
  }

  async rename(tx: MssqlTx, id: string, name: string, userId: string | null): Promise<void> {
    await tx
      .updateTable('questionnaires')
      .set({ name, updated_at: sql<Date>`SYSDATETIMEOFFSET()`, updated_by: userId })
      .where('id', '=', id)
      .execute();
  }

  /** Disables, completes (optionally with a successor) or reactivates a questionnaire. */
  async setState(
    tx: MssqlTx,
    id: string,
    state: 'active' | 'disabled' | 'completed',
    successorId: string | null = null,
  ): Promise<void> {
    await tx
      .updateTable('questionnaires')
      .set({
        state,
        state_changed_at: sql<Date>`SYSDATETIMEOFFSET()`,
        successor_id: state === 'completed' ? successorId : null,
      })
      .where('id', '=', id)
      .execute();
  }

  /** Deletes a questionnaire that was never published, with its scenarios, comments and presence. */
  async deleteUnpublished(tx: MssqlTx, id: string): Promise<void> {
    const published = await tx
      .selectFrom('questionnaire_versions')
      .select('id')
      .where('questionnaire_id', '=', id)
      .executeTakeFirst();
    if (published) throw new Error('A published questionnaire cannot be deleted');
    await tx.deleteFrom('questionnaire_scenarios').where('questionnaire_id', '=', id).execute();
    await tx.deleteFrom('questionnaire_comments').where('questionnaire_id', '=', id).execute();
    await tx.deleteFrom('questionnaire_presence').where('questionnaire_id', '=', id).execute();
    await tx.deleteFrom('questionnaires').where('id', '=', id).execute();
  }

  // Versions

  async latestVersion(tx: MssqlTx, questionnaireId: string): Promise<VersionRow | undefined> {
    const r = await tx
      .selectFrom('questionnaire_versions')
      .selectAll()
      .where('questionnaire_id', '=', questionnaireId)
      .orderBy('version', 'desc')
      .top(1)
      .executeTakeFirst();
    return r && toVersion(r);
  }

  async versions(tx: MssqlTx, questionnaireId: string) {
    return tx
      .selectFrom('questionnaire_versions')
      .select(['version', 'status', 'hash', 'published_by', 'published_at', 'retired_at'])
      .where('questionnaire_id', '=', questionnaireId)
      .orderBy('version', 'desc')
      .execute();
  }

  /** Publishes the next version of the questionnaire (under the draft's row lock). */
  async publish(
    tx: MssqlTx,
    v: {
      tenantId: string;
      questionnaireId: string;
      definition: unknown;
      compiled: { hash: string };
      mapping: unknown;
      userId: string | null;
    },
  ): Promise<{ version: number; status: string; hash: string; publishedAt: Date }> {
    const previous = await this.latestVersion(tx, v.questionnaireId);
    const version = (previous?.version ?? 0) + 1;
    await tx
      .insertInto('questionnaire_versions')
      .values({
        id: randomUUID(),
        tenant_id: v.tenantId,
        questionnaire_id: v.questionnaireId,
        version,
        definition: JSON.stringify(v.definition),
        compiled: JSON.stringify(v.compiled),
        hash: v.compiled.hash,
        mapping: v.mapping === null || v.mapping === undefined ? null : JSON.stringify(v.mapping),
        published_by: v.userId,
        retired_at: null,
      })
      .execute();
    const row = await tx
      .selectFrom('questionnaire_versions')
      .select(['version', 'status', 'hash', 'published_at'])
      .where('questionnaire_id', '=', v.questionnaireId)
      .where('version', '=', version)
      .executeTakeFirstOrThrow();
    return { version, status: row.status, hash: row.hash, publishedAt: row.published_at };
  }

  async retire(tx: MssqlTx, questionnaireId: string, version: number): Promise<void> {
    await tx
      .updateTable('questionnaire_versions')
      .set({ status: 'retired', retired_at: sql<Date>`SYSDATETIMEOFFSET()` })
      .where('questionnaire_id', '=', questionnaireId)
      .where('version', '=', version)
      .execute();
  }

  // Scenarios

  async saveScenario(
    tx: MssqlTx,
    v: {
      tenantId: string;
      questionnaireId: string;
      name: string;
      scenario: unknown;
      userId: string | null;
    },
  ): Promise<void> {
    const existing = await tx
      .selectFrom('questionnaire_scenarios')
      .select('id')
      .where('questionnaire_id', '=', v.questionnaireId)
      .where('name', '=', v.name)
      .executeTakeFirst();
    if (existing) {
      await tx
        .updateTable('questionnaire_scenarios')
        .set({ scenario: JSON.stringify(v.scenario), updated_at: sql<Date>`SYSDATETIMEOFFSET()` })
        .where('id', '=', existing.id)
        .execute();
      return;
    }
    await tx
      .insertInto('questionnaire_scenarios')
      .values({
        id: randomUUID(),
        tenant_id: v.tenantId,
        questionnaire_id: v.questionnaireId,
        name: v.name,
        scenario: JSON.stringify(v.scenario),
        created_by: v.userId,
      })
      .execute();
  }

  async scenarios(tx: MssqlTx, questionnaireId: string) {
    const rows = await tx
      .selectFrom('questionnaire_scenarios')
      .select(['id', 'name', 'scenario', 'updated_at'])
      .where('questionnaire_id', '=', questionnaireId)
      .orderBy('name')
      .execute();
    return rows.map((r) => ({ ...r, scenario: json(r.scenario) }));
  }

  async deleteScenario(tx: MssqlTx, questionnaireId: string, id: string): Promise<void> {
    await tx
      .deleteFrom('questionnaire_scenarios')
      .where('questionnaire_id', '=', questionnaireId)
      .where('id', '=', id)
      .execute();
  }

  // Review comments

  async addComment(
    tx: MssqlTx,
    v: {
      tenantId: string;
      questionnaireId: string;
      itemId: string | null;
      parentId: string | null;
      authorId: string;
      body: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('questionnaire_comments')
      .values({
        id,
        tenant_id: v.tenantId,
        questionnaire_id: v.questionnaireId,
        item_id: v.itemId,
        parent_id: v.parentId,
        author_id: v.authorId,
        body: v.body,
        resolved_at: null,
        resolved_by: null,
      })
      .execute();
    return id;
  }

  async comments(tx: MssqlTx, questionnaireId: string) {
    return tx
      .selectFrom('questionnaire_comments')
      .selectAll()
      .where('questionnaire_id', '=', questionnaireId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /** Only threads (first comments) are resolved; replies follow their thread. */
  async resolveThread(tx: MssqlTx, id: string, userId: string, resolved: boolean): Promise<void> {
    await tx
      .updateTable('questionnaire_comments')
      .set({
        resolved_at: resolved ? sql<Date>`SYSDATETIMEOFFSET()` : null,
        resolved_by: resolved ? userId : null,
        updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', id)
      .where('parent_id', 'is', null)
      .execute();
  }

  // Who is editing

  async touchPresence(
    tx: MssqlTx,
    v: { tenantId: string; questionnaireId: string; userId: string; itemId: string | null },
  ): Promise<void> {
    // Insert first and, if the person already has a row (unique key violation), update it:
    // heartbeats of one person arriving together neither insert twice nor deadlock.
    await sql`
      BEGIN TRY
        INSERT INTO dbo.questionnaire_presence (tenant_id, questionnaire_id, user_id, item_id)
        VALUES (${v.tenantId}, ${v.questionnaireId}, ${v.userId}, ${v.itemId});
      END TRY
      BEGIN CATCH
        IF ERROR_NUMBER() IN (2601, 2627)
          UPDATE dbo.questionnaire_presence
          SET item_id = ${v.itemId}, last_seen = SYSDATETIMEOFFSET()
          WHERE questionnaire_id = ${v.questionnaireId} AND user_id = ${v.userId};
        ELSE
          THROW;
      END CATCH`.execute(tx);
  }

  /** Who was seen in the last `withinSeconds`. */
  async presence(tx: MssqlTx, questionnaireId: string, withinSeconds = 30) {
    return tx
      .selectFrom('questionnaire_presence')
      .select(['user_id', 'item_id', 'last_seen'])
      .where('questionnaire_id', '=', questionnaireId)
      .where(sql<boolean>`last_seen > DATEADD(second, ${-withinSeconds}, SYSDATETIMEOFFSET())`)
      .execute();
  }

  // Library of saved items

  async saveLibraryItem(
    tx: MssqlTx,
    v: {
      tenantId: string;
      name: string;
      description: string | null;
      tags: string[];
      content: unknown;
      languages: string[];
      userId: string | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('library_items')
      .values({
        id,
        tenant_id: v.tenantId,
        name: v.name,
        description: v.description,
        tags: JSON.stringify(v.tags),
        content: JSON.stringify(v.content),
        languages: JSON.stringify(v.languages),
        created_by: v.userId,
      })
      .execute();
    return id;
  }

  /** Items whose name contains `text` or that carry the tag, by name. */
  async searchLibrary(tx: MssqlTx, opts: { text?: string; tag?: string } = {}) {
    let q = tx
      .selectFrom('library_items')
      .select(['id', 'name', 'description', 'tags', 'languages']);
    if (opts.text) q = q.where('name', 'like', `%${opts.text.replace(/[%_[]/g, '[$&]')}%`);
    if (opts.tag)
      q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM OPENJSON(tags) WHERE [value] = ${opts.tag})`);
    const rows = await q.orderBy('name').execute();
    return rows.map((r) => ({
      ...r,
      tags: json<string[]>(r.tags),
      languages: json<string[]>(r.languages),
    }));
  }

  async deleteLibraryItem(tx: MssqlTx, id: string): Promise<void> {
    await tx.deleteFrom('library_items').where('id', '=', id).execute();
  }
}
