import { Injectable } from '@nestjs/common';
import { sql as ksql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { AuditEntry } from '../audit/audit.service.js';
import { AuditStore } from '../audit/audit-store.mssql.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import type { ProjectView } from '../projects/org-repo.js';
import { CasesStore } from './cases-store.mssql.js';
import { idOrder } from '../db/mssql/order.js';

/**
 * The database side of cases (the pattern of `auth/auth-repo.ts`): the implementation uses
 * `CasesStore` and direct queries. The rules (who may see, assign, claim, what a share-out
 * does) stay in the services, written once. Rows come out camelCase with lower-case ids.
 */
export interface CaseRowView {
  id: string;
  externalId: string;
  sample: Record<string, unknown>;
  samplePii: string | null;
  questionnaireId: string | null;
  status: string;
  disposition: string | null;
  attempts: number;
  assignedAt: Date | null;
  priority: number;
  modePreference: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  checkedOutAt: Date | null;
  anonymisedAt: Date | null;
  updatedAt: Date;
  selectionRole: string | null;
  substituteFor: string | null;
  inclusionProb: number | null;
  baseWeight: number | null;
}

/** Which cases: always one project; the rest narrows. */
export interface CaseQuery {
  projectId: string;
  /** The questionnaire's cases and those of none. */
  questionnaireId?: string;
  status?: string;
  /** A user id, or `none`. */
  assignedTo?: string;
  ids?: string[];
  /** Someone who sees only their cases (and, in pool mode, the free fresh ones). */
  visibleTo?: { userId: string; pool: boolean };
  /** Text in the external id or the plain sample (personal fields hidden), or token hits. */
  search?: { term: string; hiddenFields: string[]; tokens: string[] };
}

export interface CaseOrder {
  by: 'externalId' | 'priority' | 'updatedAt';
  dir: 'asc' | 'desc';
}

export interface Assignee {
  userId: string;
  name: string;
  email: string;
  roles: string[];
}

export interface ContactView {
  id: string;
  type: string;
  value: string;
  label: string | null;
  valid: boolean | null;
  consent: string | null;
  lat: number | null;
  lng: number | null;
  geocodeQuality: string | null;
}

export interface RuleView {
  id: string;
  userId: string;
  questionnaireId: string | null;
  name: string | null;
  filter: string | null;
  quota: number | null;
  active: boolean;
  kind: string;
  createdAt: Date;
}

export interface GoalView {
  userId: string | null;
  frequency: string;
  startsOn: string;
  endsOn: string;
  target: number;
}

export interface FieldView {
  name: string;
  label: string | null;
  type: string;
  pii: boolean;
}

export interface CasesTx {
  // ─── Project, people, dictionary ────────────────────────────────────────────────────
  project(projectId: string): Promise<ProjectView | null>;
  piiFields(projectId: string): Promise<Set<string>>;
  fields(projectId: string): Promise<FieldView[]>;
  updateField(
    projectId: string,
    name: string,
    patch: { label?: string | null; pii?: boolean; type?: string },
  ): Promise<FieldView | null>;
  /** Active members who can work cases (before the role-matrix filter). */
  assigneeRows(
    projectId: string,
  ): Promise<{ userId: string; role: string; name: string; email: string }[]>;
  rolePermissions(): Promise<unknown>;
  /** The project's questionnaires, oldest first. */
  questionnaireIds(projectId: string): Promise<string[]>;

  // ─── Cases ─────────────────────────────────────────────────────────────────────────
  cases(
    q: CaseQuery,
    order?: CaseOrder,
    page?: { limit: number; offset: number },
  ): Promise<CaseRowView[]>;
  countCases(q: CaseQuery): Promise<number>;
  /** Counts per status, those finished with a complete interview, and those held by someone. */
  caseCounts(q: CaseQuery): Promise<{
    byStatus: Record<string, number>;
    completed: number;
    held: number;
  }>;
  updateCase(
    id: string,
    patch: {
      priority?: number;
      modePreference?: string | null;
      status?: string;
      reopen?: boolean;
      sample?: {
        sample: Record<string, unknown>;
        samplePii: string | null;
        index?: string[] | null;
      };
    },
  ): Promise<{ id: string; status: string; priority: number } | null>;
  contacts(caseId: string): Promise<ContactView[]>;
  history(
    caseId: string,
  ): Promise<{ type: string; details: unknown; at: Date; actor: string | null }[]>;
  caseRef(id: string): Promise<{ id: string; externalId: string } | null>;
  substituteOf(
    projectId: string,
    caseId: string,
  ): Promise<{ id: string; externalId: string } | null>;
  events(
    rows: {
      caseId: string;
      type: string;
      details?: Record<string, unknown>;
      actorUserId?: string | null;
    }[],
  ): Promise<void>;
  /** Cases of the project that are in one of the statuses, among these ids. */
  among(
    projectId: string,
    ids: string[],
    opts: { statuses?: string[]; unassigned?: boolean },
  ): Promise<{ id: string; assignedTo: string | null }[]>;
  /** Free fresh cases of the project (of the questionnaire, when given). */
  freeCaseIds(projectId: string, questionnaireId?: string): Promise<string[]>;
  /**
   * Gives these cases to the person (null: takes them back), locked and checked again; only cases
   * still in `only.statuses` and, with `only.unassigned`, still held by no one change hands.
   */
  assign(
    projectId: string,
    ids: string[],
    userId: string | null,
    only: { statuses?: string[]; unassigned?: boolean },
  ): Promise<{ id: string; from: string | null }[]>;
  /** The person takes a free fresh case; null when it is gone or not free. */
  claim(
    projectId: string,
    caseId: string,
    userId: string,
  ): Promise<{ id: string; externalId: string } | null>;
  caseHolder(
    projectId: string,
    caseId: string,
  ): Promise<{ id: string; assignedTo: string | null; status: string } | null>;
  release(caseId: string): Promise<void>;
  /** Open cases per person (assigned or in progress), among these people. */
  openLoad(projectId: string, people: string[]): Promise<{ userId: string; n: number }[]>;
  /** Cases per holder and status, for the workload. */
  workload(projectId: string): Promise<{ userId: string | null; status: string; n: number }[]>;
  /** Everything held per person (any status), for the rule strategies. */
  heldTotals(projectId: string): Promise<{ userId: string | null; n: number }[]>;

  // ─── Rules ─────────────────────────────────────────────────────────────────────────
  rules(
    projectId: string,
    opts?: { ruleId?: string; questionnaireId?: string; activeOnly?: boolean },
  ): Promise<(RuleView & { userName: string })[]>;
  createRule(v: {
    projectId: string;
    userId: string;
    questionnaireId: string | null;
    name: string | null;
    filter: string;
    quota: number | null;
    active: boolean;
    createdBy: string;
  }): Promise<RuleView>;
  updateRule(
    projectId: string,
    id: string,
    patch: {
      userId?: string;
      questionnaireId?: string | null;
      name?: string;
      filter?: string;
      quota?: number | null;
      active?: boolean;
    },
  ): Promise<RuleView | null>;
  deleteRule(projectId: string, id: string): Promise<boolean>;

  // ─── Share-out planning ────────────────────────────────────────────────────────────
  projectToday(projectId: string): Promise<string>;
  goalsInForce(projectId: string, today: string, questionnaireId?: string): Promise<GoalView[]>;
  /** Completes and days worked per person over the last `days` days. */
  output(
    projectId: string,
    people: string[],
    days: number,
    questionnaireId?: string,
  ): Promise<{ userId: string; completes: number; days: number }[]>;

  // ─── Geocoding ─────────────────────────────────────────────────────────────────────
  /** Address contacts of the project not geocoded yet (or all, with `again`). */
  pendingAddresses(
    projectId: string,
    limit: number,
    again: boolean,
  ): Promise<{ id: string; value: string }[]>;
  setGeocode(
    contactId: string,
    point: { lat: number; lng: number; quality: string } | null,
  ): Promise<void>;
  mapPoints(
    projectId: string,
    ownUserId?: string,
  ): Promise<
    {
      caseId: string;
      externalId: string;
      status: string;
      lat: number | null;
      lng: number | null;
      quality: string | null;
    }[]
  >;

  // ─── Other projects, expiry, audit ─────────────────────────────────────────────────
  /** Cases of other projects with one of these contacts. */
  contactMatches(
    projectId: string,
    pairs: [string, string][],
  ): Promise<{ type: string; value: string; caseId: string; projectId: string; name: string }[]>;
  /** Overdue assigned cases of the project closed as EXPIRED; returns them. */
  expireDue(
    projectId: string,
    now: Date,
    days: number,
  ): Promise<{ id: string; assignedTo: string | null; assignedAt: Date | null }[]>;
  projectIds(): Promise<string[]>;
  /** Auto-views of personal data already recorded by the person for these cases. */
  piiViewsSeen(actorUserId: string, caseIds: string[]): Promise<Set<string>>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface CasesRepo {
  inTenant<T>(tenantId: string, fn: (t: CasesTx) => Promise<T>): Promise<T>;
}

export const CHUNK = 1000;

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const lowOrNull = (s: string | null) => (s === null ? null : s.toLowerCase());
const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));

export class MssqlCasesTx implements CasesTx {
  constructor(
    private readonly tx: MssqlTx,
    private readonly tenantId: string,
    private readonly store: CasesStore,
  ) {}

  async project(projectId: string) {
    const r = await this.tx
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', projectId)
      .executeTakeFirst();
    return r
      ? {
          id: low(r.id),
          tenantId: low(r.tenant_id),
          name: r.name,
          code: r.code,
          status: r.status,
          modesEnabled: parse<string[]>(r.modes_enabled),
          timezone: r.timezone,
          languages: parse<string[]>(r.languages),
          settings: parse(r.settings),
          logoUpdatedAt: r.logo_updated_at,
          createdAt: r.created_at,
        }
      : null;
  }

  async piiFields(projectId: string) {
    const rows = await this.tx
      .selectFrom('sample_fields')
      .select('name')
      .where('project_id', '=', projectId)
      .where('pii', '=', true)
      .execute();
    return new Set(rows.map((r) => r.name));
  }

  async fields(projectId: string) {
    const rows = await this.tx
      .selectFrom('sample_fields')
      .select(['name', 'label', 'type', 'pii'])
      .where('project_id', '=', projectId)
      .orderBy('position')
      .orderBy('name')
      .execute();
    return rows.map((r) => ({ ...r, pii: !!r.pii }));
  }

  async updateField(
    projectId: string,
    name: string,
    patch: { label?: string | null; pii?: boolean; type?: string },
  ) {
    const set = {
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.pii !== undefined ? { pii: patch.pii } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
    };
    if (Object.keys(set).length)
      await this.tx
        .updateTable('sample_fields')
        .set(set)
        .where('project_id', '=', projectId)
        .where('name', '=', name)
        .execute();
    const r = await this.tx
      .selectFrom('sample_fields')
      .select(['name', 'label', 'type', 'pii'])
      .where('project_id', '=', projectId)
      .where('name', '=', name)
      .executeTakeFirst();
    return r ? { ...r, pii: !!r.pii } : null;
  }

  async assigneeRows(projectId: string) {
    const rows = await this.tx
      .selectFrom('memberships as g')
      .innerJoin('tenant_members as m', (j) =>
        j.onRef('m.user_id', '=', 'g.user_id').on('m.status', '=', 'active'),
      )
      .innerJoin('users as u', 'u.id', 'g.user_id')
      .select(['g.user_id', 'g.role', 'u.name', 'u.email'])
      .where((eb) => eb.or([eb('g.project_id', 'is', null), eb('g.project_id', '=', projectId)]))
      .orderBy('u.name')
      .execute();
    return rows.map((r) => ({
      userId: low(r.user_id),
      role: r.role,
      name: r.name,
      email: r.email,
    }));
  }

  async rolePermissions() {
    const t = await this.tx.selectFrom('tenants').select('role_permissions').executeTakeFirst();
    return t ? parse(t.role_permissions) : undefined;
  }

  async questionnaireIds(projectId: string) {
    const rows = await this.tx
      .selectFrom('questionnaires')
      .select('id')
      .where('project_id', '=', projectId)
      .orderBy('created_at')
      .orderBy(idOrder)
      .execute();
    return rows.map((r) => low(r.id));
  }

  private base(q: CaseQuery) {
    let b = this.tx
      .selectFrom('cases as c')
      .leftJoin('users as u', 'u.id', 'c.assigned_to')
      .where('c.project_id', '=', q.projectId);
    if (q.questionnaireId)
      b = b.where((eb) =>
        eb.or([
          eb('c.questionnaire_id', '=', q.questionnaireId!),
          eb('c.questionnaire_id', 'is', null),
        ]),
      );
    if (q.ids)
      b = b.where(
        ksql<boolean>`c.id IN (SELECT CAST(j.[value] AS uniqueidentifier) FROM OPENJSON(${JSON.stringify(q.ids)}) j)`,
      );
    if (q.visibleTo) {
      const u = q.visibleTo.userId;
      b = q.visibleTo.pool
        ? b.where((eb) =>
            eb.or([
              eb('c.assigned_to', '=', u),
              eb.and([eb('c.assigned_to', 'is', null), eb('c.status', '=', 'fresh')]),
            ]),
          )
        : b.where('c.assigned_to', '=', u);
    }
    if (q.status) b = b.where('c.status', '=', q.status);
    if (q.assignedTo === 'none') b = b.where('c.assigned_to', 'is', null);
    else if (q.assignedTo) b = b.where('c.assigned_to', '=', q.assignedTo);
    if (q.search) {
      const like = `%${q.search.term.replace(/[%_[]/g, '[$&]')}%`;
      const hidden = JSON.stringify(q.search.hiddenFields);
      // The values of the plain sample, without the personal fields (keys come in BIN2 collation).
      const values = ksql<string>`(SELECT STRING_AGG(CAST(j.[value] AS nvarchar(max)), N' ')
        FROM OPENJSON(c.sample) j
        WHERE j.[key] COLLATE DATABASE_DEFAULT NOT IN (SELECT h.[value] FROM OPENJSON(${hidden}) h))`;
      const tokenHits = q.search.tokens.length
        ? ksql<boolean>`(SELECT COUNT(DISTINCT t.[value]) FROM OPENJSON(c.sample_pii_index) t
            WHERE t.[value] COLLATE DATABASE_DEFAULT IN (SELECT w.[value] FROM OPENJSON(${JSON.stringify(
              q.search.tokens,
            )}) w)) = ${new Set(q.search.tokens).size}`
        : null;
      b = b.where((eb) =>
        eb.or([
          eb('c.external_id', 'like', like),
          ksql<boolean>`${values} LIKE ${like}`,
          ...(tokenHits ? [tokenHits] : []),
        ]),
      );
    }
    return b;
  }

  async cases(q: CaseQuery, order?: CaseOrder, page?: { limit: number; offset: number }) {
    const col =
      order?.by === 'priority'
        ? 'c.priority'
        : order?.by === 'updatedAt'
          ? 'c.updated_at'
          : 'c.external_id';
    let query = this.base(q)
      .select([
        'c.id',
        'c.external_id',
        'c.sample',
        'c.sample_pii',
        'c.questionnaire_id',
        'c.status',
        'c.disposition',
        'c.attempts',
        'c.assigned_at',
        'c.priority',
        'c.mode_preference',
        'c.assigned_to',
        'u.name as assigned_name',
        'c.checked_out_at',
        'c.anonymised_at',
        'c.updated_at',
        'c.selection_role',
        'c.substitute_for',
        'c.inclusion_prob',
        'c.base_weight',
      ])
      .orderBy(col, order?.dir ?? 'asc')
      .orderBy('c.id');
    if (page) query = query.offset(page.offset).fetch(page.limit);
    const rows = await query.execute();
    return rows.map((r) => ({
      id: low(r.id),
      externalId: r.external_id,
      sample: parse<Record<string, unknown>>(r.sample),
      samplePii: r.sample_pii,
      questionnaireId: lowOrNull(r.questionnaire_id),
      status: r.status,
      disposition: r.disposition,
      attempts: r.attempts,
      assignedAt: r.assigned_at,
      priority: r.priority,
      modePreference: r.mode_preference,
      assignedTo: lowOrNull(r.assigned_to),
      assignedName: r.assigned_name,
      checkedOutAt: r.checked_out_at,
      anonymisedAt: r.anonymised_at,
      updatedAt: r.updated_at,
      selectionRole: r.selection_role,
      substituteFor: lowOrNull(r.substitute_for),
      inclusionProb: r.inclusion_prob,
      baseWeight: r.base_weight,
    }));
  }

  async countCases(q: CaseQuery) {
    const r = await this.base(q)
      .select(ksql<number>`COUNT(*)`.as('n'))
      .executeTakeFirstOrThrow();
    return r.n;
  }

  async caseCounts(q: CaseQuery) {
    const counts = await this.base(q)
      .select(['c.status', ksql<number>`COUNT(*)`.as('n')])
      .groupBy('c.status')
      .execute();
    const done = await this.base(q)
      .select(ksql<number>`COUNT(*)`.as('n'))
      .where('c.status', '=', 'finalised')
      .where('c.disposition', '=', 'COMPLETE')
      .executeTakeFirstOrThrow();
    const held = await this.base(q)
      .select(ksql<number>`COUNT(*)`.as('n'))
      .where('c.assigned_to', 'is not', null)
      .executeTakeFirstOrThrow();
    return {
      byStatus: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      completed: done.n,
      held: held.n,
    };
  }

  async updateCase(id: string, patch: Parameters<CasesTx['updateCase']>[1]) {
    const set = {
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.modePreference !== undefined ? { mode_preference: patch.modePreference } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.reopen ? { disposition: null, assigned_to: null, assigned_at: null } : {}),
      ...(patch.sample
        ? {
            sample: JSON.stringify(patch.sample.sample),
            sample_pii: patch.sample.samplePii,
            ...(patch.sample.index !== undefined
              ? {
                  sample_pii_index:
                    patch.sample.index === null ? null : JSON.stringify(patch.sample.index),
                }
              : {}),
          }
        : {}),
      updated_at: ksql<Date>`SYSDATETIMEOFFSET()`,
    };
    const res = await this.tx.updateTable('cases').set(set).where('id', '=', id).executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return null;
    const r = await this.tx
      .selectFrom('cases')
      .select(['id', 'status', 'priority'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { id: low(r.id), status: r.status, priority: r.priority };
  }

  async contacts(caseId: string) {
    const rows = await this.tx
      .selectFrom('contacts')
      .select(['id', 'type', 'value', 'label', 'valid', 'consent', 'lat', 'lng', 'geocode_quality'])
      .where('case_id', '=', caseId)
      .orderBy('created_at')
      .orderBy(idOrder)
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      type: r.type,
      value: r.value,
      label: r.label,
      valid: r.valid === null ? null : !!r.valid,
      // A JSON column is text on SQL Server: parse it.
      consent: (typeof r.consent === 'string' ? JSON.parse(r.consent) : r.consent) as string | null,
      lat: r.lat,
      lng: r.lng,
      geocodeQuality: r.geocode_quality,
    })) as ContactView[];
  }

  async history(caseId: string) {
    const rows = await this.tx
      .selectFrom('case_events as e')
      .leftJoin('users as u', 'u.id', 'e.actor_user_id')
      .select(['e.type', 'e.details', 'e.at', 'u.name as actor'])
      .where('e.case_id', '=', caseId)
      .orderBy('e.at', 'desc')
      .top(200)
      .execute();
    return rows.map((r) => ({ type: r.type, details: parse(r.details), at: r.at, actor: r.actor }));
  }

  async caseRef(id: string) {
    const r = await this.tx
      .selectFrom('cases')
      .select(['id', 'external_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? { id: low(r.id), externalId: r.external_id } : null;
  }

  async substituteOf(projectId: string, caseId: string) {
    const r = await this.tx
      .selectFrom('cases')
      .select(['id', 'external_id'])
      .where('project_id', '=', projectId)
      .where('substitute_for', '=', caseId)
      .executeTakeFirst();
    return r ? { id: low(r.id), externalId: r.external_id } : null;
  }

  async events(rows: Parameters<CasesTx['events']>[0]) {
    // The store writes one actor per call: group by actor.
    const byActor = new Map<string | null, typeof rows>();
    for (const r of rows) {
      const k = r.actorUserId ?? null;
      byActor.set(k, [...(byActor.get(k) ?? []), r]);
    }
    for (const [actor, part] of byActor)
      await this.store.addEvents(
        this.tx,
        this.tenantId,
        actor,
        part.map((r) => ({ caseId: r.caseId, type: r.type, details: r.details })),
      );
  }

  async among(
    projectId: string,
    ids: string[],
    opts: { statuses?: string[]; unassigned?: boolean },
  ) {
    const out: { id: string; assignedTo: string | null }[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      let q = this.tx
        .selectFrom('cases')
        .select(['id', 'assigned_to'])
        .where('project_id', '=', projectId)
        .where('id', 'in', ids.slice(i, i + CHUNK));
      if (opts.statuses) q = q.where('status', 'in', opts.statuses);
      if (opts.unassigned) q = q.where('assigned_to', 'is', null);
      out.push(
        ...(await q.execute()).map((r) => ({
          id: low(r.id),
          assignedTo: lowOrNull(r.assigned_to),
        })),
      );
    }
    return out;
  }

  async freeCaseIds(projectId: string, questionnaireId?: string) {
    let q = this.tx
      .selectFrom('cases')
      .select('id')
      .where('project_id', '=', projectId)
      .where('status', '=', 'fresh')
      .where('assigned_to', 'is', null);
    if (questionnaireId)
      q = q.where((eb) =>
        eb.or([eb('questionnaire_id', '=', questionnaireId), eb('questionnaire_id', 'is', null)]),
      );
    return (await q.execute()).map((r) => low(r.id));
  }

  async assign(
    projectId: string,
    ids: string[],
    userId: string | null,
    only: { statuses?: string[]; unassigned?: boolean },
  ) {
    // The store locks the rows, checks them again and changes the ones that qualify; its history
    // events are written by the service, so they are not duplicated here.
    return this.store.assignRows(this.tx, { projectId, caseIds: ids, userId, only });
  }

  async claim(projectId: string, caseId: string, userId: string) {
    const res = await this.tx
      .updateTable('cases')
      .set({
        assigned_to: userId,
        assigned_at: ksql<Date>`SYSDATETIMEOFFSET()`,
        status: 'assigned',
        updated_at: ksql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', caseId)
      .where('project_id', '=', projectId)
      .where('assigned_to', 'is', null)
      .where('status', '=', 'fresh')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return null;
    return this.caseRef(caseId);
  }

  async caseHolder(projectId: string, caseId: string) {
    const c = await this.tx
      .selectFrom('cases')
      .select(['id', 'assigned_to', 'status'])
      .where('id', '=', caseId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return c ? { id: low(c.id), assignedTo: lowOrNull(c.assigned_to), status: c.status } : null;
  }

  async release(caseId: string) {
    await this.tx
      .updateTable('cases')
      .set({
        assigned_to: null,
        assigned_at: null,
        status: 'fresh',
        updated_at: ksql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', caseId)
      .execute();
  }

  async openLoad(projectId: string, people: string[]) {
    const rows = await this.tx
      .selectFrom('cases')
      .select(['assigned_to', ksql<number>`COUNT(*)`.as('n')])
      .where('project_id', '=', projectId)
      .where('assigned_to', 'in', people)
      .where('status', 'in', ['assigned', 'in_progress'])
      .groupBy('assigned_to')
      .execute();
    return rows.map((r) => ({ userId: low(r.assigned_to!), n: r.n }));
  }

  async workload(projectId: string) {
    const rows = await this.tx
      .selectFrom('cases')
      .select(['assigned_to', 'status', ksql<number>`COUNT(*)`.as('n')])
      .where('project_id', '=', projectId)
      .groupBy(['assigned_to', 'status'])
      .execute();
    return rows.map((r) => ({ userId: lowOrNull(r.assigned_to), status: r.status, n: r.n }));
  }

  async heldTotals(projectId: string) {
    const rows = await this.tx
      .selectFrom('cases')
      .select(['assigned_to', ksql<number>`COUNT(*)`.as('n')])
      .where('project_id', '=', projectId)
      .groupBy('assigned_to')
      .execute();
    return rows.map((r) => ({ userId: lowOrNull(r.assigned_to), n: r.n }));
  }

  private rule(r: {
    id: string;
    user_id: string;
    questionnaire_id: string | null;
    name: string | null;
    filter: string | null;
    quota: number | null;
    active: boolean;
    kind: string;
    created_at: Date;
  }): RuleView {
    return {
      id: low(r.id),
      userId: low(r.user_id),
      questionnaireId: lowOrNull(r.questionnaire_id),
      name: r.name,
      filter: r.filter,
      quota: r.quota,
      active: !!r.active,
      kind: r.kind,
      createdAt: r.created_at,
    };
  }

  async rules(
    projectId: string,
    opts: { ruleId?: string; questionnaireId?: string; activeOnly?: boolean } = {},
  ) {
    let q = this.tx
      .selectFrom('assignments as a')
      .innerJoin('users as u', 'u.id', 'a.user_id')
      .select([
        'a.id',
        'a.user_id',
        'a.questionnaire_id',
        'a.name',
        'a.filter',
        'a.quota',
        'a.active',
        'a.kind',
        'a.created_at',
        'u.name as user_name',
      ])
      .where('a.project_id', '=', projectId);
    if (opts.activeOnly) q = q.where('a.active', '=', true);
    if (opts.ruleId) q = q.where('a.id', '=', opts.ruleId);
    if (opts.questionnaireId)
      q = q.where((eb) =>
        eb.or([
          eb('a.questionnaire_id', '=', opts.questionnaireId!),
          eb('a.questionnaire_id', 'is', null),
        ]),
      );
    const rows = await q.orderBy('a.created_at').orderBy('a.id').execute();
    return rows.map((r) => ({ ...this.rule(r), userName: r.user_name }));
  }

  async createRule(v: Parameters<CasesTx['createRule']>[0]) {
    const id = randomUUID();
    await this.tx
      .insertInto('assignments')
      .values({
        id,
        tenant_id: this.tenantId,
        project_id: v.projectId,
        user_id: v.userId,
        questionnaire_id: v.questionnaireId,
        kind: 'rule',
        name: v.name,
        filter: v.filter,
        quota: v.quota,
        active: v.active,
        created_by: v.createdBy,
      })
      .execute();
    const r = await this.tx
      .selectFrom('assignments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return this.rule(r);
  }

  async updateRule(projectId: string, id: string, patch: Parameters<CasesTx['updateRule']>[2]) {
    const set = {
      ...(patch.userId !== undefined ? { user_id: patch.userId } : {}),
      ...(patch.questionnaireId !== undefined ? { questionnaire_id: patch.questionnaireId } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.filter !== undefined ? { filter: patch.filter } : {}),
      ...(patch.quota !== undefined ? { quota: patch.quota } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    };
    const found = await this.tx
      .selectFrom('assignments')
      .select('id')
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (!found) return null;
    if (Object.keys(set).length)
      await this.tx.updateTable('assignments').set(set).where('id', '=', id).execute();
    const r = await this.tx
      .selectFrom('assignments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return this.rule(r);
  }

  async deleteRule(projectId: string, id: string) {
    const res = await this.tx
      .deleteFrom('assignments')
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return Number(res.numDeletedRows) > 0;
  }

  async projectToday(projectId: string) {
    const p = await this.project(projectId);
    // The zone's offset today, computed here (SQL Server takes Windows zone names).
    const tz = p?.timezone ?? 'UTC';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    return parts;
  }

  async goalsInForce(projectId: string, today: string, questionnaireId?: string) {
    const res = await ksql<{
      user_id: string | null;
      frequency: string;
      starts_on: string;
      ends_on: string;
      target: number;
    }>`
      SELECT user_id, frequency, CONVERT(varchar(10), starts_on, 23) AS starts_on,
             CONVERT(varchar(10), ends_on, 23) AS ends_on, target
      FROM dbo.interviewer_goals
      WHERE project_id = ${projectId} AND starts_on <= ${today} AND ends_on >= ${today}
        ${
          questionnaireId
            ? ksql`AND (questionnaire_id IS NULL OR questionnaire_id = ${questionnaireId})`
            : ksql``
        }`.execute(this.tx);
    return res.rows.map((r) => ({
      userId: lowOrNull(r.user_id),
      frequency: r.frequency,
      startsOn: r.starts_on,
      endsOn: r.ends_on,
      target: r.target,
    }));
  }

  async output(projectId: string, people: string[], days: number, questionnaireId?: string) {
    const p = await this.project(projectId);
    const tz = p?.timezone ?? 'UTC';
    // Days worked: the distinct local dates of the submissions, computed in the application
    // (SQL Server's AT TIME ZONE takes Windows zone names, not the IANA ones the project uses).
    const rows = await this.tx
      .selectFrom('interviews as i')
      .innerJoin('questionnaire_versions as v', 'v.id', 'i.questionnaire_version_id')
      .select(['i.interviewer_id', 'i.disposition', 'i.status', 'i.submitted_at'])
      .where('i.project_id', '=', projectId)
      .where('i.entry_pass', '=', 1)
      .where('i.interviewer_id', 'in', people)
      .where('i.submitted_at', '>=', instant(new Date(Date.now() - days * 86_400_000)))
      .$if(!!questionnaireId, (qb) => qb.where('v.questionnaire_id', '=', questionnaireId!))
      .execute();
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    const per = new Map<string, { completes: number; days: Set<string> }>();
    for (const r of rows) {
      const id = low(r.interviewer_id!);
      const o = per.get(id) ?? { completes: 0, days: new Set<string>() };
      if (
        r.disposition === 'COMPLETE' &&
        ['submitted', 'in_review', 'approved', 'returned'].includes(r.status)
      )
        o.completes++;
      if (r.submitted_at) o.days.add(fmt.format(r.submitted_at));
      per.set(id, o);
    }
    return [...per].map(([userId, o]) => ({ userId, completes: o.completes, days: o.days.size }));
  }

  async pendingAddresses(projectId: string, limit: number, again: boolean) {
    let q = this.tx
      .selectFrom('contacts as c')
      .innerJoin('cases as k', 'k.id', 'c.case_id')
      .select(['c.id', 'c.value'])
      .where('k.project_id', '=', projectId)
      .where('c.type', '=', 'address');
    if (!again) q = q.where('c.geocoded_at', 'is', null);
    return (await q.orderBy('c.id').top(limit).execute()).map((r) => ({
      id: low(r.id),
      value: r.value,
    }));
  }

  async setGeocode(contactId: string, point: { lat: number; lng: number; quality: string } | null) {
    await this.tx
      .updateTable('contacts')
      .set({
        lat: point?.lat ?? null,
        lng: point?.lng ?? null,
        geocode_quality: point?.quality ?? 'not_found',
        geocoded_at: ksql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', contactId)
      .execute();
  }

  async mapPoints(projectId: string, ownUserId?: string) {
    let q = this.tx
      .selectFrom('contacts as c')
      .innerJoin('cases as k', 'k.id', 'c.case_id')
      .select([
        'k.id as case_id',
        'k.external_id',
        'k.status',
        'c.lat',
        'c.lng',
        'c.geocode_quality',
      ])
      .where('k.project_id', '=', projectId)
      .where('c.type', '=', 'address')
      .where('c.lat', 'is not', null);
    if (ownUserId) q = q.where('k.assigned_to', '=', ownUserId);
    return (await q.top(20_000).execute()).map((r) => ({
      caseId: low(r.case_id),
      externalId: r.external_id,
      status: r.status,
      lat: r.lat,
      lng: r.lng,
      quality: r.geocode_quality,
    }));
  }

  async contactMatches(projectId: string, pairs: [string, string][]) {
    if (!pairs.length) return [];
    const rows = await ksql<{
      type: string;
      value: string;
      case_id: string;
      project_id: string;
      name: string;
    }>`
      SELECT c.type, c.value, k.id AS case_id, p.id AS project_id, p.name
      FROM dbo.contacts c
      JOIN dbo.cases k ON k.id = c.case_id
      JOIN dbo.projects p ON p.id = k.project_id
      JOIN OPENJSON(${JSON.stringify(pairs.map(([type, value]) => ({ type, value })))})
        WITH (type nvarchar(64), value nvarchar(450)) j
        ON j.type = c.type COLLATE DATABASE_DEFAULT AND j.value = c.value COLLATE DATABASE_DEFAULT
      WHERE k.project_id <> ${projectId}`.execute(this.tx);
    return rows.rows.map((r) => ({
      type: r.type,
      value: r.value,
      caseId: low(r.case_id),
      projectId: low(r.project_id),
      name: r.name,
    }));
  }

  async expireDue(projectId: string, now: Date, days: number) {
    const res = await ksql<{ id: string; assigned_to: string | null; assigned_at: Date | null }>`
      UPDATE c SET status = 'finalised', disposition = 'EXPIRED', next_contact_at = NULL,
                   updated_at = ${instant(now)}
      OUTPUT inserted.id, inserted.assigned_to, inserted.assigned_at
      FROM dbo.cases c
      WHERE c.project_id = ${projectId} AND c.status IN ('assigned', 'in_progress')
        AND c.assigned_to IS NOT NULL
        AND c.assigned_at < ${instant(new Date(now.getTime() - days * 86_400_000))}
        AND c.checked_out_device IS NULL
        AND (c.call_lock_until IS NULL OR c.call_lock_until < ${instant(now)})
        AND NOT EXISTS (SELECT 1 FROM dbo.interviews iv
                        WHERE iv.case_id = c.id AND iv.status = 'in_progress')`.execute(this.tx);
    return res.rows.map((r) => ({
      id: low(r.id),
      assignedTo: lowOrNull(r.assigned_to),
      assignedAt: r.assigned_at,
    }));
  }

  async projectIds() {
    return (await this.tx.selectFrom('projects').select('id').execute()).map((p) => low(p.id));
  }

  async piiViewsSeen(actorUserId: string, caseIds: string[]) {
    const out = new Set<string>();
    for (let i = 0; i < caseIds.length; i += CHUNK) {
      const rows = await this.tx
        .selectFrom('audit_log')
        .select('target_id')
        .where('action', '=', 'case.pii_viewed')
        .where('actor_user_id', '=', actorUserId)
        .where('target_id', 'in', caseIds.slice(i, i + CHUNK))
        .execute();
      rows.forEach((r) => out.add(low(r.target_id!)));
    }
    return out;
  }

  audit(entry: AuditEntry) {
    return new AuditStore().record(this.tx, this.tenantId, entry);
  }
}

@Injectable()
export class MssqlCasesRepo implements CasesRepo {
  private readonly store = new CasesStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: CasesTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlCasesTx(tx, tenantId, this.store)),
    );
  }
}

export const CASES_REPO = Symbol('CASES_REPO');
