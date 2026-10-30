import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { sql as ksql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { CHUNK, MssqlCasesTx, PgCasesTx, type CasesTx } from '../cases/cases-repo.js';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { Database, type Tx } from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import {
  cases,
  contacts,
  frameUnits,
  sampleFields,
  sampleImportRows,
  sampleImports,
  samplingPlans,
} from '../db/schema.js';

/**
 * The database side of sample imports and the sampling selector, whichever engine runs (the
 * pattern of `auth/auth-repo.ts`). A transaction here is also a `CasesTx`: the rules in
 * `SamplingService` and `ImportsController` use both.
 */
export interface PlanView {
  id: string;
  projectId: string;
  questionnaireId: string | null;
  source: unknown;
  design: unknown;
  size: unknown;
  eligibility: string | null;
  exclusions: string | null;
  quotas: unknown;
  substitution: unknown;
  crossChecks: unknown;
  seed: string;
  status: string;
  result: unknown;
  selectedAt: Date | null;
}

export interface PlanChanges {
  source?: unknown;
  design?: unknown;
  size?: unknown;
  eligibility?: string | null;
  exclusions?: string | null;
  quotas?: unknown;
  substitution?: unknown;
  crossChecks?: unknown;
  /** Who changed it (and when). */
  updatedBy?: string;
  result?: unknown;
  /** Marks it selected, by this person, now. */
  selectedBy?: string;
}

export interface UnitView {
  id: string;
  projectId: string;
  questionnaireId: string | null;
  externalId: string;
  sourceLabel: string | null;
  sample: Record<string, unknown>;
  samplePii: string | null;
  contacts: { type: string; value: string; label: string | null }[];
  importId: string | null;
  eligible: boolean | null;
  exclusion: string | null;
  role: string | null;
  releaseOrder: number | null;
  releasedAt: Date | null;
  inclusionProb: number | null;
  baseWeight: number | null;
  stratum: string | null;
  caseId: string | null;
}

export interface ImportView {
  id: string;
  projectId: string;
  questionnaireId: string | null;
  fileName: string;
  size: number;
  sha256: string;
  headers: unknown;
  mapping: unknown;
  status: string;
  report: unknown;
  rows: number;
  target: string;
  sourceLabel: string | null;
  createdAt: Date;
  committedAt: Date | null;
}

export interface NewCaseRow {
  externalId: string;
  questionnaireId: string | null;
  sample: Record<string, unknown>;
  samplePii: string | null;
  samplePiiIndex?: string[] | null;
  priority?: number;
  modePreference?: string | null;
  importId?: string | null;
  frameUnitId?: string | null;
  selectionRole?: string | null;
  substituteFor?: string | null;
  inclusionProb?: number | null;
  baseWeight?: number | null;
}

export interface NewUnitRow {
  projectId: string;
  externalId: string;
  questionnaireId: string | null;
  sourceLabel: string | null;
  sample: Record<string, unknown>;
  samplePii: string | null;
  contacts: unknown;
  importId: string;
}

export interface SampleTx extends CasesTx {
  // ─── Plans ──────────────────────────────────────────────────────────────────────────
  plan(projectId: string, q: string | null, lock?: boolean): Promise<PlanView | null>;
  insertPlan(v: {
    projectId: string;
    questionnaireId: string | null;
    body: Required<
      Pick<PlanChanges, 'source' | 'design' | 'size' | 'quotas' | 'substitution' | 'crossChecks'>
    > &
      Pick<PlanChanges, 'eligibility' | 'exclusions'>;
    seed: string;
    userId: string;
  }): Promise<void>;
  updatePlan(id: string, changes: PlanChanges): Promise<void>;

  // ─── Frame ──────────────────────────────────────────────────────────────────────────
  units(projectId: string, q: string | null): Promise<UnitView[]>;
  unitsByIds(ids: string[]): Promise<UnitView[]>;
  unit(id: string): Promise<UnitView | null>;
  markUnits(items: { id: string; eligible: boolean; exclusion: string }[]): Promise<void>;
  setReserve(
    id: string,
    v: { releaseOrder: number; prob: number | null; weight: number | null; stratum: string | null },
  ): Promise<void>;
  /** Reserves with no case yet, in release order; `stratum` narrows (null: those without one). */
  reserves(
    projectId: string,
    q: string | null,
    opts: { limit: number; stratum?: { value: string | null } },
  ): Promise<UnitView[]>;
  linkUnit(
    id: string,
    v: {
      role: string;
      caseId: string;
      released: boolean;
      prob: number | null;
      weight: number | null;
      stratum: string | null;
    },
  ): Promise<void>;
  /** Units of the frame and, in a stratum, those that have a case. */
  stratumUnits(
    projectId: string,
    q: string | null,
    stratum: { value: string | null } | null,
  ): Promise<{ id: string; caseId: string | null }[]>;
  reweigh(projectId: string, unitIds: string[], prob: number, weight: number | null): Promise<void>;
  clearFrame(projectId: string, q: string | null): Promise<number>;
  frameExternalIds(projectId: string, q: string | null): Promise<Set<string>>;
  insertUnits(rows: NewUnitRow[]): Promise<string[]>;
  updateUnit(
    projectId: string,
    q: string | null,
    externalId: string,
    v: {
      sample: Record<string, unknown>;
      samplePii: string | null;
      contacts: unknown;
      sourceLabel: string | null;
    },
  ): Promise<void>;

  // ─── Cases ─────────────────────────────────────────────────────────────────────────
  selectionRoles(
    projectId: string,
    q: string | null,
  ): Promise<{ role: string | null; n: number }[]>;
  lockCase(
    projectId: string,
    id: string,
  ): Promise<{
    id: string;
    questionnaireId: string | null;
    disposition: string | null;
    frameUnitId: string | null;
  } | null>;
  hasSubstitute(projectId: string, caseId: string): Promise<boolean>;
  /** Inserts the cases, skipping external ids already there; returns those made. */
  insertCases(
    projectId: string,
    rows: NewCaseRow[],
  ): Promise<{ id: string; externalId: string; frameUnitId: string | null }[]>;
  insertContacts(
    rows: { caseId: string; type: string; value: string; label: string | null }[],
  ): Promise<void>;
  caseExternalIds(projectId: string, q: string | null): Promise<Set<string>>;
  casesByExternal(
    projectId: string,
    q: string | null,
    externalIds: string[],
  ): Promise<
    { id: string; externalId: string; sample: Record<string, unknown>; samplePii: string | null }[]
  >;
  updateFromImport(
    id: string,
    v: {
      sample: Record<string, unknown>;
      samplePii: string | null;
      samplePiiIndex: string[] | null;
      priority?: number;
      modePreference?: string;
    },
  ): Promise<void>;
  deleteContactsOf(caseId: string): Promise<void>;
  /** Recent finals for the cross-case checks. */
  recentCases(
    projectId: string,
    scope: 'project' | 'organisation',
    results: string[],
    since: Date,
  ): Promise<{ id: string; sample: unknown; samplePiiIndex: string[] | null }[]>;
  contactsOfCases(caseIds: string[]): Promise<{ caseId: string; type: string; value: string }[]>;

  // ─── Imports ───────────────────────────────────────────────────────────────────────
  importRow(projectId: string, id: string, lock?: boolean): Promise<ImportView | null>;
  committedImport(projectId: string, q: string | null, sha256: string): Promise<string | null>;
  createImport(v: {
    projectId: string;
    questionnaireId: string | null;
    fileName: string;
    size: number;
    sha256: string;
    headers: string[];
    rows: number;
    target: 'frame' | 'cases';
    sourceLabel: string | null;
    uploadedBy: string;
  }): Promise<string>;
  stageRows(importId: string, rows: string[][]): Promise<void>;
  stagedRows(importId: string, limit?: number): Promise<string[][]>;
  listImports(
    projectId: string,
    q?: string,
  ): Promise<
    Pick<
      ImportView,
      'id' | 'fileName' | 'rows' | 'status' | 'report' | 'createdAt' | 'committedAt'
    >[]
  >;
  updateImport(
    id: string,
    v: { mapping?: unknown; report?: unknown; status?: string; committedAt?: Date },
  ): Promise<void>;
  deleteStaged(importId: string): Promise<void>;
  /** Drops the staged rows of imports never committed in a day and marks them failed. */
  abandonStale(olderThan: Date): Promise<void>;
  upsertFields(
    projectId: string,
    columns: { field: string; type: string; pii: boolean }[],
  ): Promise<void>;
}

export interface SampleRepo {
  inTenant<T>(tenantId: string, fn: (t: SampleTx) => Promise<T>): Promise<T>;
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

const sameQ = (
  col:
    | typeof samplingPlans.questionnaireId
    | typeof frameUnits.questionnaireId
    | typeof cases.questionnaireId
    | typeof sampleImports.questionnaireId,
  q: string | null,
) => (q ? eq(col, q) : isNull(col));

export class PgSampleTx extends PgCasesTx implements SampleTx {
  constructor(
    private readonly stx: Tx,
    private readonly tenant: string,
    audits: AuditService,
  ) {
    super(stx, tenant, audits);
  }

  async plan(projectId: string, q: string | null, lock = false) {
    let query = this.stx
      .select()
      .from(samplingPlans)
      .where(and(eq(samplingPlans.projectId, projectId), sameQ(samplingPlans.questionnaireId, q)))
      .$dynamic();
    if (lock) query = query.for('update');
    const [p] = await query;
    return (p as PlanView | undefined) ?? null;
  }

  async insertPlan(v: Parameters<SampleTx['insertPlan']>[0]) {
    await this.stx.insert(samplingPlans).values({
      tenantId: this.tenant,
      projectId: v.projectId,
      questionnaireId: v.questionnaireId,
      ...(v.body as object),
      seed: v.seed,
      updatedBy: v.userId,
    } as typeof samplingPlans.$inferInsert);
  }

  async updatePlan(id: string, c: PlanChanges) {
    const { updatedBy, selectedBy, ...rest } = c;
    await this.stx
      .update(samplingPlans)
      .set({
        ...rest,
        ...(updatedBy ? { updatedAt: new Date(), updatedBy } : {}),
        ...(selectedBy ? { status: 'selected', selectedAt: new Date(), selectedBy } : {}),
      } as Partial<typeof samplingPlans.$inferInsert>)
      .where(eq(samplingPlans.id, id));
  }

  async units(projectId: string, q: string | null) {
    return (await this.stx
      .select()
      .from(frameUnits)
      .where(and(eq(frameUnits.projectId, projectId), sameQ(frameUnits.questionnaireId, q)))
      .orderBy(asc(frameUnits.externalId))) as UnitView[];
  }

  async unitsByIds(ids: string[]) {
    if (!ids.length) return [];
    return (await this.stx
      .select()
      .from(frameUnits)
      .where(inArray(frameUnits.id, ids))) as UnitView[];
  }

  async unit(id: string) {
    const [u] = await this.stx.select().from(frameUnits).where(eq(frameUnits.id, id));
    return (u as UnitView | undefined) ?? null;
  }

  async markUnits(items: { id: string; eligible: boolean; exclusion: string }[]) {
    for (const i of items)
      await this.stx
        .update(frameUnits)
        .set({ eligible: i.eligible, exclusion: i.exclusion })
        .where(eq(frameUnits.id, i.id));
  }

  async setReserve(id: string, v: Parameters<SampleTx['setReserve']>[1]) {
    await this.stx
      .update(frameUnits)
      .set({
        role: 'reserve',
        releaseOrder: v.releaseOrder,
        inclusionProb: v.prob,
        baseWeight: v.weight,
        stratum: v.stratum,
      })
      .where(eq(frameUnits.id, id));
  }

  async reserves(
    projectId: string,
    q: string | null,
    opts: { limit: number; stratum?: { value: string | null } },
  ) {
    return (await this.stx
      .select()
      .from(frameUnits)
      .where(
        and(
          eq(frameUnits.projectId, projectId),
          sameQ(frameUnits.questionnaireId, q),
          eq(frameUnits.role, 'reserve'),
          isNull(frameUnits.caseId),
          ...(opts.stratum
            ? [
                opts.stratum.value === null
                  ? isNull(frameUnits.stratum)
                  : eq(frameUnits.stratum, opts.stratum.value),
              ]
            : []),
        ),
      )
      .orderBy(asc(frameUnits.releaseOrder), asc(frameUnits.externalId))
      .limit(opts.limit)) as UnitView[];
  }

  async linkUnit(id: string, v: Parameters<SampleTx['linkUnit']>[1]) {
    await this.stx
      .update(frameUnits)
      .set({
        role: v.role,
        caseId: v.caseId,
        releasedAt: v.released ? new Date() : null,
        inclusionProb: v.prob,
        baseWeight: v.weight,
        stratum: v.stratum,
      })
      .where(eq(frameUnits.id, id));
  }

  stratumUnits(projectId: string, q: string | null, stratum: { value: string | null } | null) {
    return this.stx
      .select({ id: frameUnits.id, caseId: frameUnits.caseId })
      .from(frameUnits)
      .where(
        and(
          eq(frameUnits.projectId, projectId),
          sameQ(frameUnits.questionnaireId, q),
          // Units without a stratum value make a stratum of their own (null), not all units.
          stratum === null
            ? sql`true`
            : stratum.value === null
              ? isNull(frameUnits.stratum)
              : eq(frameUnits.stratum, stratum.value),
        ),
      );
  }

  async reweigh(projectId: string, unitIds: string[], prob: number, weight: number | null) {
    await this.stx
      .update(frameUnits)
      .set({ inclusionProb: prob, baseWeight: weight })
      .where(inArray(frameUnits.id, unitIds));
    await this.stx
      .update(cases)
      .set({ inclusionProb: prob, baseWeight: weight })
      .where(and(eq(cases.projectId, projectId), inArray(cases.frameUnitId, unitIds)));
  }

  async clearFrame(projectId: string, q: string | null) {
    const r = await this.stx
      .delete(frameUnits)
      .where(and(eq(frameUnits.projectId, projectId), sameQ(frameUnits.questionnaireId, q)))
      .returning({ id: frameUnits.id });
    return r.length;
  }

  async frameExternalIds(projectId: string, q: string | null) {
    const rows = await this.stx
      .select({ externalId: frameUnits.externalId })
      .from(frameUnits)
      .where(and(eq(frameUnits.projectId, projectId), sameQ(frameUnits.questionnaireId, q)));
    return new Set(rows.map((x) => x.externalId));
  }

  async insertUnits(rows: NewUnitRow[]) {
    const out: string[] = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const ins = await this.stx
        .insert(frameUnits)
        .values(
          rows.slice(i, i + CHUNK).map((r) => ({
            tenantId: this.tenant,
            ...r,
          })) as (typeof frameUnits.$inferInsert)[],
        )
        .returning({ id: frameUnits.id });
      out.push(...ins.map((x) => x.id));
    }
    return out;
  }

  async updateUnit(
    projectId: string,
    q: string | null,
    externalId: string,
    v: Parameters<SampleTx['updateUnit']>[3],
  ) {
    await this.stx
      .update(frameUnits)
      .set(v)
      .where(
        and(
          eq(frameUnits.projectId, projectId),
          sameQ(frameUnits.questionnaireId, q),
          eq(frameUnits.externalId, externalId),
        ),
      );
  }

  selectionRoles(projectId: string, q: string | null) {
    return this.stx
      .select({ role: cases.selectionRole, n: sql<number>`count(*)::int` })
      .from(cases)
      .where(
        and(
          eq(cases.projectId, projectId),
          q ? or(eq(cases.questionnaireId, q), isNull(cases.questionnaireId)) : undefined,
        ),
      )
      .groupBy(cases.selectionRole);
  }

  async lockCase(projectId: string, id: string) {
    const [c] = await this.stx
      .select({
        id: cases.id,
        questionnaireId: cases.questionnaireId,
        disposition: cases.disposition,
        frameUnitId: cases.frameUnitId,
      })
      .from(cases)
      .where(and(eq(cases.id, id), eq(cases.projectId, projectId)))
      .for('update');
    return c ?? null;
  }

  async hasSubstitute(projectId: string, caseId: string) {
    const [r] = await this.stx
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.projectId, projectId), eq(cases.substituteFor, caseId)));
    return !!r;
  }

  async insertCases(projectId: string, rows: NewCaseRow[]) {
    const out: { id: string; externalId: string; frameUnitId: string | null }[] = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const ins = await this.stx
        .insert(cases)
        .values(
          rows.slice(i, i + CHUNK).map((r) => ({
            tenantId: this.tenant,
            projectId,
            ...r,
            priority: r.priority ?? 0,
            modePreference: r.modePreference ?? null,
          })) as (typeof cases.$inferInsert)[],
        )
        .onConflictDoNothing({ target: [cases.projectId, cases.questionnaireId, cases.externalId] })
        .returning({ id: cases.id, externalId: cases.externalId, frameUnitId: cases.frameUnitId });
      out.push(...ins);
    }
    return out;
  }

  async insertContacts(rows: Parameters<SampleTx['insertContacts']>[0]) {
    for (let i = 0; i < rows.length; i += CHUNK)
      await this.stx
        .insert(contacts)
        .values(rows.slice(i, i + CHUNK).map((r) => ({ tenantId: this.tenant, ...r })));
  }

  async caseExternalIds(projectId: string, q: string | null) {
    const rows = await this.stx
      .select({ externalId: cases.externalId })
      .from(cases)
      .where(and(eq(cases.projectId, projectId), sameQ(cases.questionnaireId, q)));
    return new Set(rows.map((c) => c.externalId));
  }

  async casesByExternal(projectId: string, q: string | null, externalIds: string[]) {
    const out: Awaited<ReturnType<SampleTx['casesByExternal']>> = [];
    for (let i = 0; i < externalIds.length; i += CHUNK)
      out.push(
        ...((await this.stx
          .select({
            id: cases.id,
            externalId: cases.externalId,
            sample: cases.sample,
            samplePii: cases.samplePii,
          })
          .from(cases)
          .where(
            and(
              eq(cases.projectId, projectId),
              sameQ(cases.questionnaireId, q),
              inArray(cases.externalId, externalIds.slice(i, i + CHUNK)),
            ),
          )) as typeof out),
      );
    return out;
  }

  async updateFromImport(id: string, v: Parameters<SampleTx['updateFromImport']>[1]) {
    await this.stx
      .update(cases)
      .set({
        sample: v.sample,
        samplePii: v.samplePii,
        samplePiiIndex: v.samplePiiIndex,
        ...(v.priority !== undefined ? { priority: v.priority } : {}),
        ...(v.modePreference ? { modePreference: v.modePreference } : {}),
        updatedAt: new Date(),
      })
      .where(eq(cases.id, id));
  }

  async deleteContactsOf(caseId: string) {
    await this.stx.delete(contacts).where(eq(contacts.caseId, caseId));
  }

  async recentCases(
    projectId: string,
    scope: 'project' | 'organisation',
    results: string[],
    since: Date,
  ) {
    const list = sql.raw(
      `array[${results.map((r) => `'${r.replace(/[^A-Z_]/g, '')}'`).join(',')}]::text[]`,
    );
    const iso = since.toISOString();
    return this.stx
      .select({ id: cases.id, sample: cases.sample, samplePiiIndex: cases.samplePiiIndex })
      .from(cases)
      .where(
        and(
          scope === 'project' ? eq(cases.projectId, projectId) : undefined,
          sql`(exists (select 1 from interviews i where i.case_id = ${cases.id}
                  and i.disposition = any(${list})
                  and i.status not in ('in_progress', 'rejected')
                  and i.submitted_at >= ${iso}::timestamptz)
                or (${cases.status} = 'finalised' and ${cases.disposition} = any(${list})
                  and ${cases.updatedAt} >= ${iso}::timestamptz))`,
        ),
      );
  }

  async contactsOfCases(caseIds: string[]) {
    const out: { caseId: string; type: string; value: string }[] = [];
    for (let i = 0; i < caseIds.length; i += CHUNK)
      out.push(
        ...(await this.stx
          .select({ caseId: contacts.caseId, type: contacts.type, value: contacts.value })
          .from(contacts)
          .where(inArray(contacts.caseId, caseIds.slice(i, i + CHUNK)))),
      );
    return out;
  }

  async importRow(projectId: string, id: string, lock = false) {
    let query = this.stx
      .select()
      .from(sampleImports)
      .where(and(eq(sampleImports.id, id), eq(sampleImports.projectId, projectId)))
      .$dynamic();
    if (lock) query = query.for('update');
    const [r] = await query;
    return (r as ImportView | undefined) ?? null;
  }

  async committedImport(projectId: string, q: string | null, sha256: string) {
    const [dup] = await this.stx
      .select({ id: sampleImports.id })
      .from(sampleImports)
      .where(
        and(
          eq(sampleImports.projectId, projectId),
          sameQ(sampleImports.questionnaireId, q),
          eq(sampleImports.sha256, sha256),
          eq(sampleImports.status, 'committed'),
        ),
      )
      .limit(1);
    return dup?.id ?? null;
  }

  async createImport(v: Parameters<SampleTx['createImport']>[0]) {
    const [row] = await this.stx
      .insert(sampleImports)
      .values({ tenantId: this.tenant, ...v })
      .returning({ id: sampleImports.id });
    return row!.id;
  }

  async stageRows(importId: string, rows: string[][]) {
    for (let i = 0; i < rows.length; i += CHUNK)
      await this.stx.insert(sampleImportRows).values(
        rows.slice(i, i + CHUNK).map((data, j) => ({
          tenantId: this.tenant,
          importId,
          rowNo: i + j + 1,
          data,
        })),
      );
  }

  async stagedRows(importId: string, limit?: number) {
    let query = this.stx
      .select({ data: sampleImportRows.data })
      .from(sampleImportRows)
      .where(eq(sampleImportRows.importId, importId))
      .orderBy(asc(sampleImportRows.rowNo))
      .$dynamic();
    if (limit) query = query.limit(limit);
    return (await query).map((r) => r.data as string[]);
  }

  listImports(projectId: string, q?: string) {
    return this.stx
      .select({
        id: sampleImports.id,
        fileName: sampleImports.fileName,
        rows: sampleImports.rows,
        status: sampleImports.status,
        report: sampleImports.report,
        createdAt: sampleImports.createdAt,
        committedAt: sampleImports.committedAt,
      })
      .from(sampleImports)
      .where(
        and(
          eq(sampleImports.projectId, projectId),
          q ? eq(sampleImports.questionnaireId, q) : undefined,
        ),
      )
      .orderBy(desc(sampleImports.createdAt))
      .limit(50);
  }

  async updateImport(id: string, v: Parameters<SampleTx['updateImport']>[1]) {
    await this.stx.update(sampleImports).set(v).where(eq(sampleImports.id, id));
  }

  async deleteStaged(importId: string) {
    await this.stx.delete(sampleImportRows).where(eq(sampleImportRows.importId, importId));
  }

  async abandonStale(olderThan: Date) {
    const stale = await this.stx
      .select({ id: sampleImports.id })
      .from(sampleImports)
      .where(and(ne(sampleImports.status, 'committed'), lt(sampleImports.createdAt, olderThan)));
    if (!stale.length) return;
    const ids = stale.map((s) => s.id);
    await this.stx.delete(sampleImportRows).where(inArray(sampleImportRows.importId, ids));
    await this.stx
      .update(sampleImports)
      .set({ status: 'failed' })
      .where(inArray(sampleImports.id, ids));
  }

  async upsertFields(projectId: string, columns: { field: string; type: string; pii: boolean }[]) {
    let position = 0;
    for (const c of columns)
      await this.stx
        .insert(sampleFields)
        .values({
          tenantId: this.tenant,
          projectId,
          name: c.field,
          type: c.type,
          pii: c.pii,
          position: position++,
        })
        .onConflictDoUpdate({
          target: [sampleFields.projectId, sampleFields.name],
          set: { type: c.type, pii: sql`${sampleFields.pii} or ${c.pii}` },
        });
  }
}

@Injectable()
export class PgSampleRepo implements SampleRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  inTenant<T>(tenantId: string, fn: (t: SampleTx) => Promise<T>) {
    return this.database.withTenant(tenantId, (tx) =>
      fn(new PgSampleTx(tx, tenantId, this.audits)),
    );
  }

  /** The same operations inside a transaction someone else opened (modules not yet moved). */
  wrap(tx: Tx, tenantId: string): SampleTx {
    return new PgSampleTx(tx, tenantId, this.audits);
  }
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const lowOrNull = (s: string | null) => (s === null ? null : s.toLowerCase());
const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));
const NONE = '00000000-0000-0000-0000-000000000000';

export class MssqlSampleTx extends MssqlCasesTx implements SampleTx {
  constructor(
    private readonly mtx: MssqlTx,
    private readonly tenant: string,
    store: CasesStore,
  ) {
    super(mtx, tenant, store);
  }

  private planView(r: {
    id: string;
    project_id: string;
    questionnaire_id: string | null;
    source: string;
    design: string;
    size: string;
    eligibility: string | null;
    exclusions: string | null;
    quotas: string;
    substitution: string;
    cross_checks: string;
    seed: string;
    status: string;
    result: string | null;
    selected_at: Date | null;
  }): PlanView {
    return {
      id: low(r.id),
      projectId: low(r.project_id),
      questionnaireId: lowOrNull(r.questionnaire_id),
      source: parse(r.source),
      design: parse(r.design),
      size: parse(r.size),
      eligibility: r.eligibility,
      exclusions: r.exclusions,
      quotas: parse(r.quotas),
      substitution: parse(r.substitution),
      crossChecks: parse(r.cross_checks),
      seed: r.seed,
      status: r.status,
      result: parse(r.result),
      selectedAt: r.selected_at,
    };
  }

  async plan(projectId: string, q: string | null, lock = false) {
    const hint = ksql.raw(lock ? 'WITH (UPDLOCK, ROWLOCK)' : '');
    const where = q === null ? ksql`questionnaire_id IS NULL` : ksql`questionnaire_id = ${q}`;
    const res = await ksql<Parameters<MssqlSampleTx['planView']>[0]>`
      SELECT * FROM dbo.sampling_plans ${hint}
      WHERE project_id = ${projectId} AND ${where}`.execute(this.mtx);
    const r = res.rows[0];
    return r ? this.planView(r) : null;
  }

  async insertPlan(v: Parameters<SampleTx['insertPlan']>[0]) {
    await this.mtx
      .insertInto('sampling_plans')
      .values({
        id: randomUUID(),
        tenant_id: this.tenant,
        project_id: v.projectId,
        questionnaire_id: v.questionnaireId,
        source: JSON.stringify(v.body.source),
        design: JSON.stringify(v.body.design),
        size: JSON.stringify(v.body.size),
        eligibility: v.body.eligibility ?? null,
        exclusions: v.body.exclusions ?? null,
        quotas: JSON.stringify(v.body.quotas),
        substitution: JSON.stringify(v.body.substitution),
        cross_checks: JSON.stringify(v.body.crossChecks),
        seed: v.seed,
        result: null,
        selected_at: null,
        selected_by: null,
        updated_by: v.userId,
      })
      .execute();
  }

  async updatePlan(id: string, c: PlanChanges) {
    const j = (x: unknown) => JSON.stringify(x);
    await this.mtx
      .updateTable('sampling_plans')
      .set({
        ...(c.source !== undefined ? { source: j(c.source) } : {}),
        ...(c.design !== undefined ? { design: j(c.design) } : {}),
        ...(c.size !== undefined ? { size: j(c.size) } : {}),
        ...(c.eligibility !== undefined ? { eligibility: c.eligibility } : {}),
        ...(c.exclusions !== undefined ? { exclusions: c.exclusions } : {}),
        ...(c.quotas !== undefined ? { quotas: j(c.quotas) } : {}),
        ...(c.substitution !== undefined ? { substitution: j(c.substitution) } : {}),
        ...(c.crossChecks !== undefined ? { cross_checks: j(c.crossChecks) } : {}),
        ...(c.result !== undefined ? { result: j(c.result) } : {}),
        ...(c.updatedBy
          ? { updated_at: ksql<Date>`SYSDATETIMEOFFSET()`, updated_by: c.updatedBy }
          : {}),
        ...(c.selectedBy
          ? {
              status: 'selected',
              selected_at: ksql<Date>`SYSDATETIMEOFFSET()`,
              selected_by: c.selectedBy,
            }
          : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  private unitView(r: {
    id: string;
    project_id: string;
    questionnaire_id: string | null;
    external_id: string;
    source_label: string | null;
    sample: string;
    sample_pii: string | null;
    contacts: string;
    import_id: string | null;
    eligible: boolean;
    exclusion: string | null;
    role: string | null;
    release_order: number | null;
    released_at: Date | null;
    inclusion_prob: number | null;
    base_weight: number | null;
    stratum: string | null;
    case_id: string | null;
  }): UnitView {
    return {
      id: low(r.id),
      projectId: low(r.project_id),
      questionnaireId: lowOrNull(r.questionnaire_id),
      externalId: r.external_id,
      sourceLabel: r.source_label,
      sample: parse(r.sample),
      samplePii: r.sample_pii,
      contacts: parse(r.contacts),
      importId: lowOrNull(r.import_id),
      eligible: r.eligible === null ? null : !!r.eligible,
      exclusion: r.exclusion,
      role: r.role,
      releaseOrder: r.release_order,
      releasedAt: r.released_at,
      inclusionProb: r.inclusion_prob,
      baseWeight: r.base_weight,
      stratum: r.stratum,
      caseId: lowOrNull(r.case_id),
    };
  }

  async units(projectId: string, q: string | null) {
    let b = this.mtx.selectFrom('frame_units').selectAll().where('project_id', '=', projectId);
    b = q === null ? b.where('questionnaire_id', 'is', null) : b.where('questionnaire_id', '=', q);
    return (await b.orderBy('external_id').execute()).map((r) => this.unitView(r));
  }

  async unitsByIds(ids: string[]) {
    const out: UnitView[] = [];
    for (let i = 0; i < ids.length; i += CHUNK)
      out.push(
        ...(
          await this.mtx
            .selectFrom('frame_units')
            .selectAll()
            .where('id', 'in', ids.slice(i, i + CHUNK))
            .execute()
        ).map((r) => this.unitView(r)),
      );
    return out;
  }

  async unit(id: string) {
    const r = await this.mtx
      .selectFrom('frame_units')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? this.unitView(r) : null;
  }

  async markUnits(items: { id: string; eligible: boolean; exclusion: string }[]) {
    for (const i of items)
      await this.mtx
        .updateTable('frame_units')
        .set({ eligible: i.eligible, exclusion: i.exclusion })
        .where('id', '=', i.id)
        .execute();
  }

  async setReserve(id: string, v: Parameters<SampleTx['setReserve']>[1]) {
    await this.mtx
      .updateTable('frame_units')
      .set({
        role: 'reserve',
        release_order: v.releaseOrder,
        inclusion_prob: v.prob,
        base_weight: v.weight,
        stratum: v.stratum,
      })
      .where('id', '=', id)
      .execute();
  }

  async reserves(
    projectId: string,
    q: string | null,
    opts: { limit: number; stratum?: { value: string | null } },
  ) {
    let b = this.mtx
      .selectFrom('frame_units')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('role', '=', 'reserve')
      .where('case_id', 'is', null);
    b = q === null ? b.where('questionnaire_id', 'is', null) : b.where('questionnaire_id', '=', q);
    if (opts.stratum)
      b =
        opts.stratum.value === null
          ? b.where('stratum', 'is', null)
          : b.where('stratum', '=', opts.stratum.value);
    const rows = await b.orderBy('release_order').orderBy('external_id').top(opts.limit).execute();
    return rows.map((r) => this.unitView(r));
  }

  async linkUnit(id: string, v: Parameters<SampleTx['linkUnit']>[1]) {
    await this.mtx
      .updateTable('frame_units')
      .set({
        role: v.role,
        case_id: v.caseId,
        released_at: v.released ? ksql<Date>`SYSDATETIMEOFFSET()` : null,
        inclusion_prob: v.prob,
        base_weight: v.weight,
        stratum: v.stratum,
      })
      .where('id', '=', id)
      .execute();
  }

  async stratumUnits(
    projectId: string,
    q: string | null,
    stratum: { value: string | null } | null,
  ) {
    let b = this.mtx
      .selectFrom('frame_units')
      .select(['id', 'case_id'])
      .where('project_id', '=', projectId);
    b = q === null ? b.where('questionnaire_id', 'is', null) : b.where('questionnaire_id', '=', q);
    if (stratum !== null)
      b =
        stratum.value === null
          ? b.where('stratum', 'is', null)
          : b.where('stratum', '=', stratum.value);
    return (await b.execute()).map((r) => ({ id: low(r.id), caseId: lowOrNull(r.case_id) }));
  }

  async reweigh(projectId: string, unitIds: string[], prob: number, weight: number | null) {
    for (let i = 0; i < unitIds.length; i += CHUNK) {
      const part = unitIds.slice(i, i + CHUNK);
      await this.mtx
        .updateTable('frame_units')
        .set({ inclusion_prob: prob, base_weight: weight })
        .where('id', 'in', part)
        .execute();
      await this.mtx
        .updateTable('cases')
        .set({ inclusion_prob: prob, base_weight: weight })
        .where('project_id', '=', projectId)
        .where('frame_unit_id', 'in', part)
        .execute();
    }
  }

  async clearFrame(projectId: string, q: string | null) {
    let b = this.mtx.deleteFrom('frame_units').where('project_id', '=', projectId);
    b = q === null ? b.where('questionnaire_id', 'is', null) : b.where('questionnaire_id', '=', q);
    return Number((await b.executeTakeFirst()).numDeletedRows);
  }

  async frameExternalIds(projectId: string, q: string | null) {
    let b = this.mtx
      .selectFrom('frame_units')
      .select('external_id')
      .where('project_id', '=', projectId);
    b = q === null ? b.where('questionnaire_id', 'is', null) : b.where('questionnaire_id', '=', q);
    return new Set((await b.execute()).map((r) => r.external_id));
  }

  async insertUnits(rows: NewUnitRow[]) {
    const out: string[] = [];
    // All rows of one call share the project and the questionnaire.
    for (let i = 0; i < rows.length; i += 2000) {
      const part = rows.slice(i, i + 2000).map((r) => ({
        id: randomUUID(),
        ext: r.externalId,
        label: r.sourceLabel,
        sample: JSON.stringify(r.sample),
        pii: r.samplePii,
        contacts: JSON.stringify(r.contacts ?? []),
        importId: r.importId,
      }));
      const first = rows[0]!;
      await ksql`
        INSERT INTO dbo.frame_units (id, tenant_id, project_id, questionnaire_id, external_id,
          source_label, sample, sample_pii, contacts, import_id)
        SELECT j.id, ${this.tenant}, ${first.projectId}, ${first.questionnaireId}, j.ext, j.label,
          j.sample, j.pii, j.contacts, j.importId
        FROM OPENJSON(${JSON.stringify(part)}) WITH (
          id uniqueidentifier, ext nvarchar(450), label nvarchar(450), sample nvarchar(max),
          pii nvarchar(max), contacts nvarchar(max), importId uniqueidentifier
        ) j`.execute(this.mtx);
      out.push(...part.map((p) => p.id));
    }
    return out;
  }

  async updateUnit(
    projectId: string,
    q: string | null,
    externalId: string,
    v: Parameters<SampleTx['updateUnit']>[3],
  ) {
    let b = this.mtx
      .updateTable('frame_units')
      .set({
        sample: JSON.stringify(v.sample),
        sample_pii: v.samplePii,
        contacts: JSON.stringify(v.contacts ?? []),
        source_label: v.sourceLabel,
      })
      .where('project_id', '=', projectId)
      .where('external_id', '=', externalId);
    b = q === null ? b.where('questionnaire_id', 'is', null) : b.where('questionnaire_id', '=', q);
    await b.execute();
  }

  async selectionRoles(projectId: string, q: string | null) {
    let b = this.mtx
      .selectFrom('cases')
      .select(['selection_role', ksql<number>`COUNT(*)`.as('n')])
      .where('project_id', '=', projectId);
    if (q)
      b = b.where((eb) =>
        eb.or([eb('questionnaire_id', '=', q), eb('questionnaire_id', 'is', null)]),
      );
    return (await b.groupBy('selection_role').execute()).map((r) => ({
      role: r.selection_role,
      n: r.n,
    }));
  }

  async lockCase(projectId: string, id: string) {
    const res = await ksql<{
      id: string;
      questionnaire_id: string | null;
      disposition: string | null;
      frame_unit_id: string | null;
    }>`SELECT id, questionnaire_id, disposition, frame_unit_id
       FROM dbo.cases WITH (UPDLOCK, ROWLOCK) WHERE id = ${id} AND project_id = ${projectId}`.execute(
      this.mtx,
    );
    const r = res.rows[0];
    return r
      ? {
          id: low(r.id),
          questionnaireId: lowOrNull(r.questionnaire_id),
          disposition: r.disposition,
          frameUnitId: lowOrNull(r.frame_unit_id),
        }
      : null;
  }

  async hasSubstitute(projectId: string, caseId: string) {
    const r = await this.mtx
      .selectFrom('cases')
      .select('id')
      .where('project_id', '=', projectId)
      .where('substitute_for', '=', caseId)
      .top(1)
      .executeTakeFirst();
    return !!r;
  }

  async insertCases(projectId: string, rows: NewCaseRow[]) {
    const out: { id: string; externalId: string; frameUnitId: string | null }[] = [];
    for (let i = 0; i < rows.length; i += 1000) {
      const part = rows.slice(i, i + 1000).map((r) => ({
        id: randomUUID(),
        ext: r.externalId,
        q: r.questionnaireId,
        sample: JSON.stringify(r.sample),
        pii: r.samplePii,
        piiIndex: r.samplePiiIndex ? JSON.stringify(r.samplePiiIndex) : null,
        priority: r.priority ?? 0,
        mode: r.modePreference ?? null,
        importId: r.importId ?? null,
        unit: r.frameUnitId ?? null,
        role: r.selectionRole ?? null,
        subst: r.substituteFor ?? null,
        prob: r.inclusionProb ?? null,
        weight: r.baseWeight ?? null,
      }));
      const res = await ksql<{ id: string; external_id: string; frame_unit_id: string | null }>`
        DECLARE @out TABLE (id uniqueidentifier, external_id nvarchar(450), frame_unit_id uniqueidentifier);
        INSERT INTO dbo.cases (id, tenant_id, project_id, questionnaire_id, external_id, sample,
          sample_pii, sample_pii_index, priority, mode_preference, import_id, frame_unit_id,
          selection_role, substitute_for, inclusion_prob, base_weight)
        OUTPUT inserted.id, inserted.external_id, inserted.frame_unit_id INTO @out
        SELECT j.id, ${this.tenant}, ${projectId}, j.q, j.ext, j.sample, j.pii, j.piiIndex,
          j.priority, j.mode, j.importId, j.unit, j.role, j.subst, j.prob, j.weight
        FROM OPENJSON(${JSON.stringify(part)}) WITH (
          id uniqueidentifier, ext nvarchar(450), q uniqueidentifier, sample nvarchar(max),
          pii nvarchar(max), piiIndex nvarchar(max), priority int, mode nvarchar(32),
          importId uniqueidentifier, unit uniqueidentifier, role nvarchar(32),
          subst uniqueidentifier, prob float, weight float
        ) j
        WHERE NOT EXISTS (
          SELECT 1 FROM dbo.cases c WITH (UPDLOCK, HOLDLOCK)
          WHERE c.project_id = ${projectId}
            AND ISNULL(c.questionnaire_id, CAST(${NONE} AS uniqueidentifier)) = ISNULL(j.q, CAST(${NONE} AS uniqueidentifier))
            AND c.external_id = j.ext
        );
        SELECT id, external_id, frame_unit_id FROM @out;`.execute(this.mtx);
      out.push(
        ...res.rows.map((r) => ({
          id: low(r.id),
          externalId: r.external_id,
          frameUnitId: lowOrNull(r.frame_unit_id),
        })),
      );
    }
    return out;
  }

  async insertContacts(rows: Parameters<SampleTx['insertContacts']>[0]) {
    for (let i = 0; i < rows.length; i += 2000)
      await ksql`
        INSERT INTO dbo.contacts (id, tenant_id, case_id, type, value, label)
        SELECT NEWID(), ${this.tenant}, j.caseId, j.type, j.value, j.label
        FROM OPENJSON(${JSON.stringify(rows.slice(i, i + 2000))}) WITH (
          caseId uniqueidentifier, type nvarchar(32), value nvarchar(450), label nvarchar(450)
        ) j`.execute(this.mtx);
  }

  async caseExternalIds(projectId: string, q: string | null) {
    let b = this.mtx.selectFrom('cases').select('external_id').where('project_id', '=', projectId);
    b = q === null ? b.where('questionnaire_id', 'is', null) : b.where('questionnaire_id', '=', q);
    return new Set((await b.execute()).map((r) => r.external_id));
  }

  async casesByExternal(projectId: string, q: string | null, externalIds: string[]) {
    const out: Awaited<ReturnType<SampleTx['casesByExternal']>> = [];
    for (let i = 0; i < externalIds.length; i += CHUNK) {
      let b = this.mtx
        .selectFrom('cases')
        .select(['id', 'external_id', 'sample', 'sample_pii'])
        .where('project_id', '=', projectId)
        .where('external_id', 'in', externalIds.slice(i, i + CHUNK));
      b =
        q === null ? b.where('questionnaire_id', 'is', null) : b.where('questionnaire_id', '=', q);
      out.push(
        ...(await b.execute()).map((r) => ({
          id: low(r.id),
          externalId: r.external_id,
          sample: parse<Record<string, unknown>>(r.sample),
          samplePii: r.sample_pii,
        })),
      );
    }
    return out;
  }

  async updateFromImport(id: string, v: Parameters<SampleTx['updateFromImport']>[1]) {
    await this.mtx
      .updateTable('cases')
      .set({
        sample: JSON.stringify(v.sample),
        sample_pii: v.samplePii,
        sample_pii_index: v.samplePiiIndex ? JSON.stringify(v.samplePiiIndex) : null,
        ...(v.priority !== undefined ? { priority: v.priority } : {}),
        ...(v.modePreference ? { mode_preference: v.modePreference } : {}),
        updated_at: ksql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async deleteContactsOf(caseId: string) {
    await this.mtx.deleteFrom('contacts').where('case_id', '=', caseId).execute();
  }

  async recentCases(
    projectId: string,
    scope: 'project' | 'organisation',
    results: string[],
    since: Date,
  ) {
    const list = ksql.join(results.map((r) => ksql`${r}`));
    const res = await ksql<{ id: string; sample: string; sample_pii_index: string | null }>`
      SELECT c.id, c.sample, c.sample_pii_index FROM dbo.cases c
      WHERE ${scope === 'project' ? ksql`c.project_id = ${projectId}` : ksql`1 = 1`}
        AND (EXISTS (SELECT 1 FROM dbo.interviews i WHERE i.case_id = c.id
                AND i.disposition IN (${list})
                AND i.status NOT IN ('in_progress', 'rejected')
                AND i.submitted_at >= ${instant(since)})
             OR (c.status = 'finalised' AND c.disposition IN (${list})
                AND c.updated_at >= ${instant(since)}))`.execute(this.mtx);
    return res.rows.map((r) => ({
      id: low(r.id),
      sample: parse(r.sample),
      samplePiiIndex: parse<string[] | null>(r.sample_pii_index),
    }));
  }

  async contactsOfCases(caseIds: string[]) {
    const out: { caseId: string; type: string; value: string }[] = [];
    for (let i = 0; i < caseIds.length; i += CHUNK)
      out.push(
        ...(
          await this.mtx
            .selectFrom('contacts')
            .select(['case_id', 'type', 'value'])
            .where('case_id', 'in', caseIds.slice(i, i + CHUNK))
            .execute()
        ).map((r) => ({ caseId: low(r.case_id), type: r.type, value: r.value })),
      );
    return out;
  }

  private importView(r: {
    id: string;
    project_id: string;
    questionnaire_id: string | null;
    file_name: string;
    size: number;
    sha256: string;
    headers: string;
    mapping: string | null;
    status: string;
    report: string | null;
    rows: number;
    target: string;
    source_label: string | null;
    created_at: Date;
    committed_at: Date | null;
  }): ImportView {
    return {
      id: low(r.id),
      projectId: low(r.project_id),
      questionnaireId: lowOrNull(r.questionnaire_id),
      fileName: r.file_name,
      size: r.size,
      sha256: r.sha256,
      headers: parse(r.headers),
      mapping: parse(r.mapping),
      status: r.status,
      report: parse(r.report),
      rows: r.rows,
      target: r.target,
      sourceLabel: r.source_label,
      createdAt: r.created_at,
      committedAt: r.committed_at,
    };
  }

  async importRow(projectId: string, id: string, lock = false) {
    const res = await ksql<Parameters<MssqlSampleTx['importView']>[0]>`
      SELECT * FROM dbo.sample_imports ${ksql.raw(lock ? 'WITH (UPDLOCK, ROWLOCK)' : '')}
      WHERE id = ${id} AND project_id = ${projectId}`.execute(this.mtx);
    const r = res.rows[0];
    return r ? this.importView(r) : null;
  }

  async committedImport(projectId: string, q: string | null, sha256: string) {
    let b = this.mtx
      .selectFrom('sample_imports')
      .select('id')
      .where('project_id', '=', projectId)
      .where('sha256', '=', sha256)
      .where('status', '=', 'committed');
    b = q === null ? b.where('questionnaire_id', 'is', null) : b.where('questionnaire_id', '=', q);
    const r = await b.top(1).executeTakeFirst();
    return r ? low(r.id) : null;
  }

  async createImport(v: Parameters<SampleTx['createImport']>[0]) {
    const id = randomUUID();
    await this.mtx
      .insertInto('sample_imports')
      .values({
        id,
        tenant_id: this.tenant,
        project_id: v.projectId,
        questionnaire_id: v.questionnaireId,
        file_name: v.fileName,
        size: v.size,
        sha256: v.sha256,
        headers: JSON.stringify(v.headers),
        mapping: null,
        report: null,
        rows: v.rows,
        target: v.target,
        source_label: v.sourceLabel,
        uploaded_by: v.uploadedBy,
        committed_at: null,
      })
      .execute();
    return id;
  }

  async stageRows(importId: string, rows: string[][]) {
    for (let i = 0; i < rows.length; i += 2000) {
      const part = rows
        .slice(i, i + 2000)
        .map((data, j) => ({ no: i + j + 1, data: JSON.stringify(data) }));
      await ksql`
        INSERT INTO dbo.sample_import_rows (tenant_id, import_id, row_no, data)
        SELECT ${this.tenant}, ${importId}, j.no, j.data
        FROM OPENJSON(${JSON.stringify(part)}) WITH (no int, data nvarchar(max)) j`.execute(
        this.mtx,
      );
    }
  }

  async stagedRows(importId: string, limit?: number) {
    let b = this.mtx
      .selectFrom('sample_import_rows')
      .select('data')
      .where('import_id', '=', importId)
      .orderBy('row_no');
    if (limit) b = b.top(limit);
    return (await b.execute()).map((r) => parse<string[]>(r.data));
  }

  async listImports(projectId: string, q?: string) {
    let b = this.mtx
      .selectFrom('sample_imports')
      .select(['id', 'file_name', 'rows', 'status', 'report', 'created_at', 'committed_at'])
      .where('project_id', '=', projectId);
    if (q) b = b.where('questionnaire_id', '=', q);
    return (await b.orderBy('created_at', 'desc').top(50).execute()).map((r) => ({
      id: low(r.id),
      fileName: r.file_name,
      rows: r.rows,
      status: r.status,
      report: parse(r.report),
      createdAt: r.created_at,
      committedAt: r.committed_at,
    }));
  }

  async updateImport(id: string, v: Parameters<SampleTx['updateImport']>[1]) {
    await this.mtx
      .updateTable('sample_imports')
      .set({
        ...(v.mapping !== undefined ? { mapping: JSON.stringify(v.mapping) } : {}),
        ...(v.report !== undefined ? { report: JSON.stringify(v.report) } : {}),
        ...(v.status !== undefined ? { status: v.status } : {}),
        ...(v.committedAt ? { committed_at: instant(v.committedAt) } : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  async deleteStaged(importId: string) {
    await this.mtx.deleteFrom('sample_import_rows').where('import_id', '=', importId).execute();
  }

  async abandonStale(olderThan: Date) {
    const stale = await this.mtx
      .selectFrom('sample_imports')
      .select('id')
      .where('status', '<>', 'committed')
      .where('created_at', '<', instant(olderThan))
      .execute();
    if (!stale.length) return;
    const ids = stale.map((s) => s.id);
    await this.mtx.deleteFrom('sample_import_rows').where('import_id', 'in', ids).execute();
    await this.mtx
      .updateTable('sample_imports')
      .set({ status: 'failed' })
      .where('id', 'in', ids)
      .execute();
  }

  async upsertFields(projectId: string, columns: { field: string; type: string; pii: boolean }[]) {
    let position = 0;
    for (const c of columns) {
      const res = await this.mtx
        .updateTable('sample_fields')
        .set({
          type: c.type,
          pii: ksql<boolean>`CASE WHEN pii = 1 OR ${c.pii ? 1 : 0} = 1 THEN 1 ELSE 0 END`,
        })
        .where('project_id', '=', projectId)
        .where('name', '=', c.field)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0)
        await this.mtx
          .insertInto('sample_fields')
          .values({
            id: randomUUID(),
            tenant_id: this.tenant,
            project_id: projectId,
            name: c.field,
            label: null,
            type: c.type,
            pii: c.pii,
            position: position,
          })
          .execute();
      position++;
    }
  }
}

@Injectable()
export class MssqlSampleRepo implements SampleRepo {
  private readonly store = new CasesStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: SampleTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlSampleTx(tx, tenantId, this.store)),
    );
  }
}

export const SAMPLE_REPO = Symbol('SAMPLE_REPO');
