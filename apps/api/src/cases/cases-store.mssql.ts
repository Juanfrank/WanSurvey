import { randomUUID } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { sql, type Selectable } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';
import type { MssqlSchema } from '../db/mssql/schema.js';
import { idOrder } from '../db/mssql/order.js';

/**
 * Cases, contacts, history and assignment on SQL Server (Kysely): what `cases.service.ts` and the
 * imports do on PostgreSQL with Drizzle, as a store for the switch (docs/roadmap.md). Takes the
 * transaction of `MssqlDatabase.withTenant`.
 *
 * Bulk writes send ONE JSON parameter and open it with OPENJSON: SQL Server allows 2100 parameters
 * per statement, which a row-by-row INSERT of a large sample would exceed.
 */
export type CaseRow = Omit<Selectable<MssqlSchema['cases']>, 'sample'> & {
  sample: Record<string, unknown>;
};

const json = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));
const toCase = (r: Selectable<MssqlSchema['cases']>): CaseRow => ({ ...r, sample: json(r.sample) });

/** Ids per statement when they travel as parameters (the limit is 2100). */
const ID_CHUNK = 1000;
const chunks = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

export interface NewCase {
  externalId: string;
  questionnaireId?: string | null;
  sample?: Record<string, unknown>;
  samplePii?: string | null;
  /** Keyed hashes of the words of the personal fields. */
  samplePiiIndex?: string[] | null;
  priority?: number;
  modePreference?: string | null;
  importId?: string | null;
  contacts?: { type: string; value: string; label?: string | null }[];
}

export interface CaseFilter {
  projectId: string;
  questionnaireId?: string | null;
  statuses?: string[];
  assignedTo?: string | null | 'any';
  /** Hashes that must all be in the personal-field index. */
  piiTokens?: string[];
  /** Matches the external id or the non-personal sample as text (case-insensitive). */
  text?: string;
}

export class CasesStore {
  // Sample fields

  /** Adds the fields and keeps a field personal once any load says so. */
  async ensureFields(
    tx: MssqlTx,
    tenantId: string,
    projectId: string,
    fields: { name: string; type?: string; pii?: boolean; label?: string | null }[],
  ): Promise<void> {
    for (const f of fields) {
      const updated = await tx
        .updateTable('sample_fields')
        .set({ pii: sql<boolean>`CASE WHEN pii = 1 OR ${f.pii ? 1 : 0} = 1 THEN 1 ELSE 0 END` })
        .where('project_id', '=', projectId)
        .where('name', '=', f.name)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) > 0) continue;
      const position = await tx
        .selectFrom('sample_fields')
        .select(sql<number>`COUNT(*)`.as('n'))
        .where('project_id', '=', projectId)
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('sample_fields')
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          project_id: projectId,
          name: f.name,
          label: f.label ?? null,
          type: f.type ?? 'text',
          pii: f.pii ?? false,
          position: position.n,
        })
        .execute();
    }
  }

  async fields(tx: MssqlTx, projectId: string) {
    return tx
      .selectFrom('sample_fields')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('position')
      .orderBy('name')
      .execute();
  }

  // Cases

  /**
   * Loads cases and their contacts in one round trip. A repeated external id (per project and
   * questionnaire) fails the whole load with SQL Server error 2627, as the unique index does on
   * PostgreSQL. Returns the ids in the order given.
   */
  async insertCases(
    tx: MssqlTx,
    v: { tenantId: string; projectId: string; cases: NewCase[] },
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const part of chunks(v.cases, 2000)) {
      // Time-ordered ids, as on PostgreSQL: ties in the call queue go to the older case.
      const rows = part.map((c) => ({
        id: uuidv7(),
        qid: c.questionnaireId ?? null,
        ext: c.externalId,
        sample: JSON.stringify(c.sample ?? {}),
        pii: c.samplePii ?? null,
        piiIndex: c.samplePiiIndex ? JSON.stringify(c.samplePiiIndex) : null,
        priority: c.priority ?? 0,
        mode: c.modePreference ?? null,
        importId: c.importId ?? null,
      }));
      await sql`
        INSERT INTO dbo.cases (id, tenant_id, project_id, questionnaire_id, external_id, sample,
          sample_pii, sample_pii_index, priority, mode_preference, import_id)
        SELECT j.id, ${v.tenantId}, ${v.projectId}, j.qid, j.ext, j.sample, j.pii, j.piiIndex,
          j.priority, j.mode, j.importId
        FROM OPENJSON(${JSON.stringify(rows)}) WITH (
          id uniqueidentifier, qid uniqueidentifier, ext nvarchar(450), sample nvarchar(max),
          pii nvarchar(max), piiIndex nvarchar(max), priority int, mode nvarchar(32),
          importId uniqueidentifier
        ) j`.execute(tx);
      const contacts = part.flatMap((c, i) =>
        (c.contacts ?? []).map((k) => ({
          id: randomUUID(),
          caseId: rows[i]!.id,
          type: k.type,
          value: k.value,
          label: k.label ?? null,
        })),
      );
      if (contacts.length)
        await sql`
          INSERT INTO dbo.contacts (id, tenant_id, case_id, type, value, label)
          SELECT j.id, ${v.tenantId}, j.caseId, j.type, j.value, j.label
          FROM OPENJSON(${JSON.stringify(contacts)}) WITH (
            id uniqueidentifier, caseId uniqueidentifier, type nvarchar(32), value nvarchar(450),
            label nvarchar(450)
          ) j`.execute(tx);
      ids.push(...rows.map((r) => r.id));
    }
    return ids;
  }

  async get(tx: MssqlTx, projectId: string, id: string): Promise<CaseRow | undefined> {
    const r = await tx
      .selectFrom('cases')
      .selectAll()
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return r && toCase(r);
  }

  /** A page in the order priority (high first) then id, after the cursor of the previous page. */
  async list(
    tx: MssqlTx,
    f: CaseFilter,
    page: { limit: number; after?: { priority: number; id: string } } = { limit: 50 },
  ): Promise<CaseRow[]> {
    let q = tx.selectFrom('cases').selectAll().where('project_id', '=', f.projectId);
    if (f.questionnaireId !== undefined)
      q =
        f.questionnaireId === null
          ? q.where('questionnaire_id', 'is', null)
          : q.where((eb) =>
              eb.or([
                eb('questionnaire_id', '=', f.questionnaireId!),
                eb('questionnaire_id', 'is', null),
              ]),
            );
    if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
    if (f.assignedTo === null) q = q.where('assigned_to', 'is', null);
    else if (f.assignedTo && f.assignedTo !== 'any') q = q.where('assigned_to', '=', f.assignedTo);
    for (const token of f.piiTokens ?? [])
      q = q.where(
        sql<boolean>`EXISTS (SELECT 1 FROM OPENJSON(sample_pii_index) WHERE [value] = ${token})`,
      );
    if (f.text) {
      const like = `%${f.text.replace(/[%_[]/g, '[$&]')}%`;
      q = q.where((eb) => eb.or([eb('external_id', 'like', like), eb('sample', 'like', like)]));
    }
    if (page.after)
      q = q.where(
        sql<boolean>`(priority < ${page.after.priority} OR (priority = ${page.after.priority} AND id > ${page.after.id}))`,
      );
    const rows = await q.orderBy('priority', 'desc').orderBy('id').top(page.limit).execute();
    return rows.map(toCase);
  }

  async countByStatus(tx: MssqlTx, projectId: string): Promise<Record<string, number>> {
    const rows = await tx
      .selectFrom('cases')
      .select(['status', sql<number>`COUNT(*)`.as('n')])
      .where('project_id', '=', projectId)
      .groupBy('status')
      .execute();
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** Cases held per person (unassigned cases are not counted). */
  async heldByUser(tx: MssqlTx, projectId: string): Promise<Map<string, number>> {
    const rows = await tx
      .selectFrom('cases')
      .select(['assigned_to', sql<number>`COUNT(*)`.as('n')])
      .where('project_id', '=', projectId)
      .where('assigned_to', 'is not', null)
      .groupBy('assigned_to')
      .execute();
    return new Map(rows.map((r) => [r.assigned_to!.toLowerCase(), r.n]));
  }

  // History (append-only)

  async addEvents(
    tx: MssqlTx,
    tenantId: string,
    actorUserId: string | null,
    events: { caseId: string; type: string; details?: Record<string, unknown> }[],
  ): Promise<void> {
    for (const part of chunks(events, 2000)) {
      if (!part.length) continue;
      const rows = part.map((e) => ({
        id: randomUUID(),
        caseId: e.caseId,
        type: e.type,
        details: JSON.stringify(e.details ?? {}),
      }));
      await sql`
        INSERT INTO dbo.case_events (id, tenant_id, case_id, type, details, actor_user_id)
        SELECT j.id, ${tenantId}, j.caseId, j.type, j.details, ${actorUserId}
        FROM OPENJSON(${JSON.stringify(rows)}) WITH (
          id uniqueidentifier, caseId uniqueidentifier, type nvarchar(64), details nvarchar(max)
        ) j`.execute(tx);
    }
  }

  async events(tx: MssqlTx, caseId: string) {
    const rows = await tx
      .selectFrom('case_events')
      .select(['type', 'details', 'actor_user_id', 'at'])
      .where('case_id', '=', caseId)
      .orderBy('at')
      .orderBy(idOrder)
      .execute();
    return rows.map((r) => ({ ...r, details: json<Record<string, unknown>>(r.details) }));
  }

  // Assignment

  /**
   * Gives cases to a person (or takes them back with `userId` null): fresh cases become assigned
   * and, on unassigning, assigned ones become fresh again. Rows are locked first, so two
   * supervisors assigning the same cases queue up. Cases that already belong to the person, or do
   * not meet `only`, are left alone. Returns the cases changed.
   */
  async assign(
    tx: MssqlTx,
    v: {
      tenantId: string;
      actorUserId: string | null;
      projectId: string;
      caseIds: string[];
      userId: string | null;
      via: string;
      only?: { statuses?: string[]; unassigned?: boolean };
    },
  ): Promise<{ id: string; from: string | null }[]> {
    const changed = await this.assignRows(tx, v);
    await this.addEvents(
      tx,
      v.tenantId,
      v.actorUserId,
      changed.map((c) => ({
        caseId: c.id,
        type: v.userId ? 'assigned' : 'unassigned',
        details: { from: c.from, to: v.userId, via: v.via },
      })),
    );
    return changed;
  }

  /** The same without the history events (the caller writes them). */
  async assignRows(
    tx: MssqlTx,
    v: {
      projectId: string;
      caseIds: string[];
      userId: string | null;
      only?: { statuses?: string[]; unassigned?: boolean };
    },
  ): Promise<{ id: string; from: string | null }[]> {
    let changed: { id: string; from: string | null }[] = [];
    for (const part of chunks(v.caseIds, ID_CHUNK)) {
      let q = sql<{ id: string; from: string | null }>`
        SELECT id, assigned_to AS [from] FROM dbo.cases WITH (UPDLOCK, ROWLOCK)
        WHERE project_id = ${v.projectId} AND id IN (${sql.join(part)})`;
      if (v.only?.statuses?.length) q = sql`${q} AND status IN (${sql.join(v.only.statuses)})`;
      if (v.only?.unassigned) q = sql`${q} AND assigned_to IS NULL`;
      q = sql`${q} ORDER BY id`;
      const before = (await q.execute(tx)).rows
        .map((r) => ({ id: r.id.toLowerCase(), from: r.from?.toLowerCase() ?? null }))
        .filter((b) => b.from !== v.userId);
      if (!before.length) continue;
      await tx
        .updateTable('cases')
        .set({
          assigned_to: v.userId,
          assigned_at: v.userId ? sql<Date>`SYSDATETIMEOFFSET()` : null,
          status: v.userId
            ? sql<string>`CASE WHEN status = 'fresh' THEN 'assigned' ELSE status END`
            : sql<string>`CASE WHEN status = 'assigned' THEN 'fresh' ELSE status END`,
          updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
        })
        .where(
          'id',
          'in',
          before.map((b) => b.id),
        )
        .execute();
      changed = changed.concat(before);
    }
    return changed;
  }

  /**
   * Pool mode: a person takes one free case. The conditional update makes two simultaneous
   * claims safe: only one finds the case still free.
   */
  async claim(
    tx: MssqlTx,
    v: { projectId: string; caseId: string; userId: string },
  ): Promise<'claimed' | 'taken' | 'not_found'> {
    const done = await tx
      .updateTable('cases')
      .set({
        assigned_to: v.userId,
        assigned_at: sql<Date>`SYSDATETIMEOFFSET()`,
        status: 'assigned',
        updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', v.caseId)
      .where('project_id', '=', v.projectId)
      .where('assigned_to', 'is', null)
      .where('status', '=', 'fresh')
      .executeTakeFirst();
    if (Number(done.numUpdatedRows) > 0) return 'claimed';
    const exists = await tx
      .selectFrom('cases')
      .select('id')
      .where('id', '=', v.caseId)
      .where('project_id', '=', v.projectId)
      .executeTakeFirst();
    return exists ? 'taken' : 'not_found';
  }

  /**
   * Pool mode: takes the next free case (highest priority first) for a person. READPAST skips
   * cases other claims hold locks on, so simultaneous claims each get a different case instead of
   * waiting for one another.
   */
  async claimNext(
    tx: MssqlTx,
    v: { projectId: string; userId: string; questionnaireId?: string },
  ): Promise<string | null> {
    const res = await sql<{ id: string }>`
      WITH next AS (
        SELECT TOP (1) * FROM dbo.cases WITH (UPDLOCK, READPAST, ROWLOCK, INDEX(cases_pool_idx))
        WHERE project_id = ${v.projectId} AND assigned_to IS NULL AND status = 'fresh'
          ${v.questionnaireId ? sql`AND (questionnaire_id = ${v.questionnaireId} OR questionnaire_id IS NULL)` : sql``}
        ORDER BY priority DESC, id
      )
      UPDATE next SET assigned_to = ${v.userId}, assigned_at = SYSDATETIMEOFFSET(),
        status = 'assigned', updated_at = SYSDATETIMEOFFSET()
      OUTPUT inserted.id`.execute(tx);
    return res.rows[0]?.id.toLowerCase() ?? null;
  }

  /**
   * Closes the project's overdue cases (held longer than `days` since assignment) as EXPIRED and
   * returns them. Cases downloaded to a device, locked for a call, or with an interview in
   * progress are left alone.
   */
  async expireOverdue(
    tx: MssqlTx,
    v: { projectId: string; days: number },
  ): Promise<{ id: string; assignedTo: string | null; assignedAt: Date }[]> {
    const res = await sql<{ id: string; assigned_to: string | null; assigned_at: Date }>`
      UPDATE c SET status = 'finalised', disposition = 'EXPIRED', next_contact_at = NULL,
        updated_at = SYSDATETIMEOFFSET()
      OUTPUT inserted.id, inserted.assigned_to, deleted.assigned_at
      FROM dbo.cases c
      WHERE c.project_id = ${v.projectId}
        AND c.status IN ('assigned', 'in_progress')
        AND c.assigned_to IS NOT NULL
        AND c.assigned_at < DATEADD(day, ${-v.days}, SYSDATETIMEOFFSET())
        AND c.checked_out_device IS NULL
        AND (c.call_lock_until IS NULL OR c.call_lock_until < SYSDATETIMEOFFSET())
        AND NOT EXISTS (SELECT 1 FROM dbo.interviews iv WHERE iv.case_id = c.id AND iv.status = 'in_progress')`.execute(
      tx,
    );
    return res.rows.map((r) => ({
      id: r.id.toLowerCase(),
      assignedTo: r.assigned_to?.toLowerCase() ?? null,
      assignedAt: r.assigned_at,
    }));
  }

  // Assignment rules

  async addRule(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      userId: string;
      questionnaireId?: string | null;
      kind: 'list' | 'rule';
      name?: string | null;
      filter?: string | null;
      quota?: number | null;
      createdBy: string | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('assignments')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        user_id: v.userId,
        questionnaire_id: v.questionnaireId ?? null,
        kind: v.kind,
        name: v.name ?? null,
        filter: v.filter ?? null,
        quota: v.quota ?? null,
        created_by: v.createdBy,
      })
      .execute();
    return id;
  }

  async rules(tx: MssqlTx, projectId: string) {
    return tx
      .selectFrom('assignments')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at')
      .orderBy(idOrder)
      .execute();
  }
}
