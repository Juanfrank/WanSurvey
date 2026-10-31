import { Injectable } from '@nestjs/common';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { sql as ksql } from 'kysely';
import { MssqlCasesTx, type CasesTx } from '../cases/cases-repo.js';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import type { CaseFull } from '../interviews/interviews-repo.js';

/**
 * The database side of personal-data handling (sealing, retention, erasure and access requests),
 * whichever engine runs (the pattern of `auth/auth-repo.ts`). A transaction here is also a
 * `CasesTx`.
 */
export interface UnitScrub {
  id: string;
  sample: Record<string, unknown>;
  importId: string | null;
}

export interface MismatchRow {
  id: string;
  variable: string;
  firstValue: unknown;
  secondValue: unknown;
  resolvedValue: unknown;
}

export interface PrivacyTx extends CasesTx {
  caseRow(projectId: string, caseId: string): Promise<CaseFull | null>;
  /** Cases with a plain value in one of these personal fields. */
  unsealed(
    projectId: string,
    fields: string[],
  ): Promise<{ id: string; sample: Record<string, unknown>; samplePii: string | null }[]>;
  /** Finished cases not yet anonymised and older than `before`, oldest first. */
  dueForRetention(projectId: string, before: Date, limit: number): Promise<string[]>;
  anonymiseCase(caseId: string, plain: Record<string, unknown>, now: Date): Promise<void>;
  deleteContacts(caseId: string): Promise<number>;
  scrubCalls(caseId: string): Promise<void>;
  scrubInvitations(caseId: string): Promise<void>;
  unitsOfCase(projectId: string, caseId: string, frameUnitId: string | null): Promise<UnitScrub[]>;
  scrubUnit(id: string, plain: Record<string, unknown>): Promise<void>;
  importsToScrub(
    projectId: string,
    ids: string[],
  ): Promise<{ id: string; headers: unknown; mapping: unknown; report: unknown }[]>;
  setImportReport(id: string, report: unknown): Promise<void>;
  deleteScanPages(caseId: string): Promise<void>;
  interviewsOfCase(
    caseId: string,
  ): Promise<{ id: string; answers: unknown; state: unknown; compiled: unknown }[]>;
  scrubInterview(id: string, answers: unknown, state: unknown, now: Date): Promise<void>;
  eraseHistory(interviewId: string, names: string[]): Promise<void>;
  mismatches(caseId: string): Promise<MismatchRow[]>;
  setMismatch(
    id: string,
    v: { firstValue: unknown; secondValue: unknown; resolvedValue: unknown },
  ): Promise<void>;

  // Access request
  subjectContacts(
    caseId: string,
  ): Promise<{ type: string; value: string; label: string | null; consent: unknown }[]>;
  subjectInterviews(caseId: string): Promise<unknown[]>;
  subjectCalls(caseId: string): Promise<unknown[]>;
  subjectInvitations(caseId: string): Promise<unknown[]>;
  subjectEvents(caseId: string): Promise<{ type: string; at: Date }[]>;
  piiViews(caseId: string): Promise<Date[]>;
}

export interface PrivacyRepo {
  inTenant<T>(tenantId: string, fn: (t: PrivacyTx) => Promise<T>): Promise<T>;
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const lowOrNull = (s: string | null) => (s === null ? null : s.toLowerCase());
const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));

export class MssqlPrivacyTx extends MssqlCasesTx implements PrivacyTx {
  constructor(
    private readonly xtx: MssqlTx,
    tn: string,
    cstore: CasesStore,
  ) {
    super(xtx, tn, cstore);
  }

  async caseRow(projectId: string, caseId: string) {
    const res = await ksql<Record<string, unknown> & { sample: string }>`
      SELECT * FROM dbo.cases WHERE id = ${caseId} AND project_id = ${projectId}`.execute(this.xtx);
    const r = res.rows[0];
    if (!r) return null;
    const g = (k: string) => r[k] as never;
    return {
      id: low(r.id as string),
      projectId: low(r.project_id as string),
      externalId: g('external_id'),
      sample: parse(r.sample),
      samplePii: g('sample_pii'),
      status: g('status'),
      disposition: g('disposition'),
      anonymisedAt: g('anonymised_at'),
      importId: lowOrNull((r.import_id as string | null) ?? null),
      frameUnitId: lowOrNull((r.frame_unit_id as string | null) ?? null),
    } as unknown as CaseFull;
  }

  async unsealed(projectId: string, fields: string[]) {
    const res = await ksql<{ id: string; sample: string; sample_pii: string | null }>`
      SELECT c.id, c.sample, c.sample_pii FROM dbo.cases c
      WHERE c.project_id = ${projectId}
        AND EXISTS (SELECT 1 FROM OPENJSON(c.sample) s
                    WHERE s.[key] COLLATE DATABASE_DEFAULT IN
                      (SELECT f.[value] FROM OPENJSON(${JSON.stringify(fields)}) f))`.execute(
      this.xtx,
    );
    return res.rows.map((r) => ({
      id: low(r.id),
      sample: parse<Record<string, unknown>>(r.sample),
      samplePii: r.sample_pii,
    }));
  }

  async dueForRetention(projectId: string, before: Date, limit: number) {
    const rows = await this.xtx
      .selectFrom('cases')
      .select('id')
      .where('project_id', '=', projectId)
      .where('status', 'in', ['finalised', 'withdrawn'])
      .where('anonymised_at', 'is', null)
      .where('updated_at', '<', instant(before))
      .orderBy('updated_at')
      .top(limit)
      .execute();
    return rows.map((r) => low(r.id));
  }

  async anonymiseCase(caseId: string, plain: Record<string, unknown>, now: Date) {
    await this.xtx
      .updateTable('cases')
      .set({
        sample: JSON.stringify(plain),
        sample_pii: null,
        sample_pii_index: null,
        anonymised_at: instant(now),
        updated_at: instant(now),
      })
      .where('id', '=', caseId)
      .execute();
  }

  async deleteContacts(caseId: string) {
    const r = await this.xtx
      .deleteFrom('contacts')
      .where('case_id', '=', caseId)
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  async scrubCalls(caseId: string) {
    // Calls with a result are history: the owner procedure clears only the note and the number.
    await ksql`EXEC dbo.erase_call_notes @case = ${caseId}`.execute(this.xtx);
  }

  async scrubInvitations(caseId: string) {
    await this.xtx
      .updateTable('invitations')
      .set({ email: null })
      .where('case_id', '=', caseId)
      .execute();
  }

  async unitsOfCase(projectId: string, caseId: string, frameUnitId: string | null) {
    const rows = await this.xtx
      .selectFrom('frame_units')
      .select(['id', 'sample', 'import_id'])
      .where('project_id', '=', projectId)
      .where((eb) =>
        eb.or([eb('case_id', '=', caseId), ...(frameUnitId ? [eb('id', '=', frameUnitId)] : [])]),
      )
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      sample: parse<Record<string, unknown>>(r.sample),
      importId: lowOrNull(r.import_id),
    }));
  }

  async scrubUnit(id: string, plain: Record<string, unknown>) {
    await this.xtx
      .updateTable('frame_units')
      .set({ sample: JSON.stringify(plain), sample_pii: null, contacts: '[]' })
      .where('id', '=', id)
      .execute();
  }

  async importsToScrub(projectId: string, ids: string[]) {
    const rows = await this.xtx
      .selectFrom('sample_imports')
      .select(['id', 'headers', 'mapping', 'report'])
      .where('project_id', '=', projectId)
      .where('id', 'in', ids)
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      headers: parse(r.headers),
      mapping: parse(r.mapping),
      report: parse(r.report),
    }));
  }

  async setImportReport(id: string, report: unknown) {
    await this.xtx
      .updateTable('sample_imports')
      .set({ report: JSON.stringify(report) })
      .where('id', '=', id)
      .execute();
  }

  async deleteScanPages(caseId: string) {
    await ksql`
      DELETE FROM dbo.papi_scan_pages
      WHERE form_id IN (SELECT id FROM dbo.papi_scan_forms WHERE case_id = ${caseId})`.execute(
      this.xtx,
    );
  }

  async interviewsOfCase(caseId: string) {
    const rows = await this.xtx
      .selectFrom('interviews as i')
      .innerJoin('questionnaire_versions as v', 'v.id', 'i.questionnaire_version_id')
      .select(['i.id', 'i.answers', 'i.state', 'v.compiled'])
      .where('i.case_id', '=', caseId)
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      answers: parse(r.answers),
      state: parse(r.state),
      compiled: parse<CompiledQuestionnaire>(r.compiled),
    }));
  }

  async scrubInterview(id: string, answers: unknown, state: unknown, now: Date) {
    await this.xtx
      .updateTable('interviews')
      .set({
        answers: JSON.stringify(answers),
        state: JSON.stringify(state),
        context: '{}',
        updated_at: instant(now),
      })
      .where('id', '=', id)
      .execute();
  }

  async eraseHistory(interviewId: string, names: string[]) {
    await ksql`EXEC dbo.erase_interview_history @interview = ${interviewId}, @variables = ${JSON.stringify(names)}`.execute(
      this.xtx,
    );
  }

  async mismatches(caseId: string) {
    const rows = await this.xtx
      .selectFrom('entry_mismatches')
      .select(['id', 'variable', 'first_value', 'second_value', 'resolved_value'])
      .where('case_id', '=', caseId)
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      variable: r.variable,
      firstValue: parse(r.first_value),
      secondValue: parse(r.second_value),
      resolvedValue: parse(r.resolved_value),
    }));
  }

  async setMismatch(
    id: string,
    v: { firstValue: unknown; secondValue: unknown; resolvedValue: unknown },
  ) {
    const j = (x: unknown) => (x === null || x === undefined ? null : JSON.stringify(x));
    await this.xtx
      .updateTable('entry_mismatches')
      .set({
        first_value: j(v.firstValue),
        second_value: j(v.secondValue),
        resolved_value: j(v.resolvedValue),
      })
      .where('id', '=', id)
      .execute();
  }

  async subjectContacts(caseId: string) {
    const rows = await this.xtx
      .selectFrom('contacts')
      .select(['type', 'value', 'label', 'consent'])
      .where('case_id', '=', caseId)
      .execute();
    return rows.map((r) => ({ ...r, consent: parse<unknown>(r.consent) }));
  }

  async subjectInterviews(caseId: string) {
    const rows = await this.xtx
      .selectFrom('interviews')
      .select(['id', 'mode', 'status', 'language', 'started_at', 'submitted_at', 'answers'])
      .where('case_id', '=', caseId)
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      mode: r.mode,
      status: r.status,
      language: r.language,
      startedAt: r.started_at,
      submittedAt: r.submitted_at,
      answers: parse(r.answers),
    }));
  }

  async subjectCalls(caseId: string) {
    const rows = await this.xtx
      .selectFrom('call_attempts')
      .select(['started_at', 'outcome', 'note', 'number_masked'])
      .where('case_id', '=', caseId)
      .execute();
    return rows.map((r) => ({
      startedAt: r.started_at,
      outcome: r.outcome,
      note: r.note,
      number: r.number_masked,
    }));
  }

  async subjectInvitations(caseId: string) {
    const rows = await this.xtx
      .selectFrom('invitations')
      .select(['email', 'status', 'sent_at', 'opened_at', 'completed_at'])
      .where('case_id', '=', caseId)
      .execute();
    return rows.map((r) => ({
      email: r.email,
      status: r.status,
      sentAt: r.sent_at,
      openedAt: r.opened_at,
      completedAt: r.completed_at,
    }));
  }

  async subjectEvents(caseId: string) {
    const rows = await this.xtx
      .selectFrom('case_events')
      .select(['type', 'at'])
      .where('case_id', '=', caseId)
      .orderBy('at')
      .execute();
    return rows.map((r) => ({ type: r.type, at: r.at as Date }));
  }

  async piiViews(caseId: string) {
    const rows = await this.xtx
      .selectFrom('audit_log')
      .select('at')
      .where('target_id', '=', caseId)
      .where('action', '=', 'case.pii_viewed')
      .execute();
    return rows.map((r) => r.at as Date);
  }
}

@Injectable()
export class MssqlPrivacyRepo implements PrivacyRepo {
  private readonly cstore = new CasesStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: PrivacyTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlPrivacyTx(tx, tenantId, this.cstore)),
    );
  }
}

export const PRIVACY_REPO = Symbol('PRIVACY_REPO');
