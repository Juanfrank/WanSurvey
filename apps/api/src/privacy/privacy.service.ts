import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import type { Question } from '@wansurvey/schema';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { can, type AuthContext } from '../common/auth-context.js';
import { CasesService } from '../cases/cases.service.js';
import { Database, type Tx } from '../db/database.js';
import {
  auditLog,
  callAttempts,
  caseEvents,
  cases,
  contacts,
  entryMismatches,
  frameUnits,
  interviews,
  invitations,
  papiScanForms,
  papiScanPages,
  projects,
  questionnaireVersions,
  sampleImports,
} from '../db/schema.js';
import { ImportMapping, type ImportReport } from '../cases/sample-mapping.js';
import { JobsService, PROCESS_ROLE, type ProcessRole } from '../jobs/jobs.service.js';

/** Removes the given keys at any depth (top-level answers and roster rows). */
export function stripKeys(value: unknown, names: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, names));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // Answer keys like `HH[2].NAME` (stash, confirmations) end with the variable name.
    if (names.has(k.replace(/^.*\./, ''))) continue;
    out[k] = stripKeys(v, names);
  }
  return out;
}

/** Variables of a questionnaire version marked as personal data. */
export function personalVariables(compiled: CompiledQuestionnaire): Set<string> {
  const names = new Set<string>();
  for (const n of compiled.nodes) {
    if (n.kind !== 'question') continue;
    const q = n.def as Question;
    if (q.personal) {
      names.add(q.name);
      names.add(`${q.name}_OTHER`);
    }
  }
  return names;
}

/**
 * Personal data over its life (H1–H3): sealing personal sample fields, removing personal data
 * after the project's retention period, and a data subject's requests to see or erase what is
 * held about them. Every change is audited.
 */
@Injectable()
export class PrivacyService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger('Privacy');

  constructor(
    private readonly database: Database,
    private readonly cases: CasesService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    @Inject(PROCESS_ROLE) private readonly role: ProcessRole,
  ) {}

  onModuleInit() {
    this.jobs.register('pii.encrypt', () => this.sealAll());
    this.jobs.schedule('pii.encrypt', { cron: '15 * * * *' });
    this.jobs.register('privacy.retention', () => this.retentionAll());
    this.jobs.schedule('privacy.retention', { cron: '30 2 * * *' });
  }

  async onApplicationBootstrap() {
    // Plain personal fields (written before encryption, or by a field newly marked personal)
    // are sealed when the worker starts, then every hour.
    if (this.role === 'worker' && !this.jobs.inline)
      await this.jobs.offer('pii.encrypt', {}, { delayMs: 5000 });
  }

  /** Seals the personal fields still held in plain text in one project. */
  async sealProject(tx: Tx, tenantId: string, projectId: string): Promise<number> {
    const pii = [...(await this.cases.piiFields(tx, projectId))];
    if (!pii.length) return 0;
    const rows = await tx
      .select({ id: cases.id, sample: cases.sample, samplePii: cases.samplePii })
      .from(cases)
      .where(
        and(eq(cases.projectId, projectId), sql`${cases.sample} ?| ${sql.param(pii)}::text[]`),
      );
    const fields = new Set(pii);
    for (const r of rows)
      await tx
        .update(cases)
        .set(this.cases.pii.seal(this.cases.pii.read(r), fields))
        .where(eq(cases.id, r.id));
    if (rows.length)
      await this.audit.record(tx, tenantId, {
        action: 'cases.pii_sealed',
        targetType: 'project',
        targetId: projectId,
        details: { cases: rows.length, fields: pii },
      });
    return rows.length;
  }

  async sealAll(): Promise<number> {
    let n = 0;
    for (const tenantId of await this.database.allTenantIds())
      n += await this.database.withTenant(tenantId, async (tx) => {
        let m = 0;
        for (const p of await tx.select({ id: projects.id }).from(projects))
          m += await this.sealProject(tx, tenantId, p.id);
        return m;
      });
    if (n) this.logger.log(`Sealed personal fields of ${n} cases`);
    return n;
  }

  /** Nightly: cases finished longer ago than their project keeps personal data. */
  async retentionAll(now = new Date()): Promise<number> {
    let n = 0;
    for (const tenantId of await this.database.allTenantIds()) {
      try {
        n += await this.database.withTenant(tenantId, async (tx) => {
          let m = 0;
          for (const p of await tx.select().from(projects)) {
            const days = (await this.cases.settings(tx, p.id)).retention.anonymiseAfterDays;
            if (!days) continue;
            const due = await tx
              .select({ id: cases.id })
              .from(cases)
              .where(
                and(
                  eq(cases.projectId, p.id),
                  inArray(cases.status, ['finalised', 'withdrawn']),
                  isNull(cases.anonymisedAt),
                  lt(cases.updatedAt, new Date(now.getTime() - days * 86_400_000)),
                ),
              )
              .orderBy(asc(cases.updatedAt))
              .limit(5000);
            for (const c of due) await this.anonymise(tx, tenantId, null, p.id, c.id, 'retention');
            m += due.length;
          }
          return m;
        });
      } catch (e) {
        this.logger.error(`Retention failed for ${tenantId}: ${(e as Error).message}`);
      }
    }
    if (n) await this.refreshAnalysis();
    return n;
  }

  /**
   * The analysis model keeps copies of the answers: refreshed once erased cases are committed,
   * not at its next scheduled time.
   */
  refreshAnalysis() {
    return this.jobs.offer('bi.refresh', {}, { jobId: 'erasure' });
  }

  /**
   * Removes a case's personal data and keeps the rest for statistics: personal sample fields
   * (also on its unit of the sampling frame), contacts, answers marked personal (with their
   * history and their double-entry differences), notes, the case copy kept with each
   * interview, call notes, invitation addresses, scanned pages of its paper forms and the
   * personal values shown as examples in the report of the import it came from.
   */
  async anonymise(
    tx: Tx,
    tenantId: string,
    ctx: AuthContext | null,
    projectId: string,
    caseId: string,
    reason: 'retention' | 'request',
    note?: string,
  ): Promise<{ interviews: number; contacts: number }> {
    const [c] = await tx
      .select()
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.projectId, projectId)));
    if (!c) throw new NotFoundException('Case not found');
    const pii = await this.cases.piiFields(tx, projectId);
    const plain = Object.fromEntries(
      Object.entries((c.sample ?? {}) as Record<string, unknown>).filter(([k]) => !pii.has(k)),
    );
    const now = new Date();
    await tx
      .update(cases)
      .set({
        sample: plain,
        samplePii: null,
        samplePiiIndex: null,
        anonymisedAt: now,
        updatedAt: now,
      })
      .where(eq(cases.id, caseId));
    const gone = await tx
      .delete(contacts)
      .where(eq(contacts.caseId, caseId))
      .returning({ id: contacts.id });
    await tx
      .update(callAttempts)
      .set({ note: null, numberMasked: null })
      .where(eq(callAttempts.caseId, caseId));
    await tx.update(invitations).set({ email: null }).where(eq(invitations.caseId, caseId));
    const units = await tx
      .select({ id: frameUnits.id, sample: frameUnits.sample, importId: frameUnits.importId })
      .from(frameUnits)
      .where(
        and(
          eq(frameUnits.projectId, projectId),
          or(
            eq(frameUnits.caseId, caseId),
            ...(c.frameUnitId ? [eq(frameUnits.id, c.frameUnitId)] : []),
          ),
        ),
      );
    for (const u of units)
      await tx
        .update(frameUnits)
        .set({
          sample: Object.fromEntries(
            Object.entries((u.sample ?? {}) as Record<string, unknown>).filter(
              ([k]) => !pii.has(k),
            ),
          ),
          samplePii: null,
          contacts: [],
        })
        .where(eq(frameUnits.id, u.id));
    const imports = [c.importId, ...units.map((u) => u.importId)].filter((x): x is string => !!x);
    await this.scrubImportReports(tx, projectId, [...new Set(imports)], pii);
    // Scanned pages show the whole form, handwriting and all.
    await tx
      .delete(papiScanPages)
      .where(
        inArray(
          papiScanPages.formId,
          tx
            .select({ id: papiScanForms.id })
            .from(papiScanForms)
            .where(eq(papiScanForms.caseId, caseId)),
        ),
      );

    const ivs = await tx
      .select({
        id: interviews.id,
        answers: interviews.answers,
        state: interviews.state,
        compiled: questionnaireVersions.compiled,
      })
      .from(interviews)
      .innerJoin(
        questionnaireVersions,
        eq(questionnaireVersions.id, interviews.questionnaireVersionId),
      )
      .where(eq(interviews.caseId, caseId));
    const personal = new Set<string>();
    for (const iv of ivs) {
      const names = personalVariables(iv.compiled as CompiledQuestionnaire);
      names.forEach((n) => personal.add(n));
      await tx
        .update(interviews)
        .set({
          answers: stripKeys(iv.answers, names) as Record<string, unknown>,
          state: stripKeys(iv.state, names) as Record<string, unknown>,
          context: {},
          // Seen as a change by the analysis model, which is then refreshed.
          updatedAt: now,
        })
        .where(eq(interviews.id, iv.id));
      await tx.execute(
        sql`select erase_interview_history(${iv.id}::uuid, ${sql.param([...names])}::text[])`,
      );
    }
    // Double-entry differences keep both keyed values: personal ones go, rosters lose theirs.
    for (const m of await tx
      .select()
      .from(entryMismatches)
      .where(eq(entryMismatches.caseId, caseId))) {
      const gone = personal.has(m.variable);
      const strip = (v: unknown) => (gone ? null : stripKeys(v, personal));
      await tx
        .update(entryMismatches)
        .set({
          firstValue: strip(m.firstValue),
          secondValue: strip(m.secondValue),
          resolvedValue: strip(m.resolvedValue),
        })
        .where(eq(entryMismatches.id, m.id));
    }
    await this.cases.events(tx, tenantId, ctx?.userId ?? null, [
      { caseId, type: 'anonymised', details: { reason } },
    ]);
    const entry = {
      action: 'case.anonymised' as const,
      targetType: 'case',
      targetId: caseId,
      details: {
        projectId,
        reason,
        interviews: ivs.length,
        contacts: gone.length,
        ...(note ? { note } : {}),
      },
    };
    await this.audit.record(tx, tenantId, ctx ? this.audit.fromContext(ctx, entry) : entry);
    return { interviews: ivs.length, contacts: gone.length };
  }

  /**
   * Blanks the example values of personal columns (contacts and personal sample fields) in
   * the validation reports of these imports.
   */
  private async scrubImportReports(
    tx: Tx,
    projectId: string,
    importIds: string[],
    pii: ReadonlySet<string>,
  ) {
    if (!importIds.length) return;
    const rows = await tx
      .select({
        id: sampleImports.id,
        headers: sampleImports.headers,
        mapping: sampleImports.mapping,
        report: sampleImports.report,
      })
      .from(sampleImports)
      .where(and(eq(sampleImports.projectId, projectId), inArray(sampleImports.id, importIds)));
    for (const r of rows) {
      const report = r.report as ImportReport | null;
      if (!report?.issues?.length) continue;
      const mapping = ImportMapping.safeParse(r.mapping);
      const headers = (r.headers ?? []) as string[];
      const personal = new Set<string>();
      // Without a mapping nothing says which columns are personal: every example goes.
      if (mapping.success)
        mapping.data.columns.forEach((col, i) => {
          if (col.kind === 'contact' || (col.kind === 'sample' && (col.pii || pii.has(col.field))))
            personal.add(headers[i] ?? `Column ${i + 1}`);
        });
      const issues = report.issues.map((it) => ({
        ...it,
        examples: it.examples.map((e) =>
          !mapping.success || personal.has(e.column) ? { ...e, value: '' } : e,
        ),
      }));
      await tx
        .update(sampleImports)
        .set({ report: { ...report, issues } })
        .where(eq(sampleImports.id, r.id));
    }
  }

  /** Everything held about a case's respondent, for a data subject access request (H3). */
  async subjectData(tx: Tx, ctx: AuthContext, projectId: string, caseId: string) {
    if (!can(ctx.memberships, 'pii.view', projectId))
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You may not see personal data' });
    const [c] = await tx
      .select()
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.projectId, projectId)));
    if (!c) throw new NotFoundException('Case not found');
    const [cs, ivs, calls, invs, events] = await Promise.all([
      tx
        .select({
          type: contacts.type,
          value: contacts.value,
          label: contacts.label,
          consent: contacts.consent,
        })
        .from(contacts)
        .where(eq(contacts.caseId, caseId)),
      tx
        .select({
          id: interviews.id,
          mode: interviews.mode,
          status: interviews.status,
          language: interviews.language,
          startedAt: interviews.startedAt,
          submittedAt: interviews.submittedAt,
          answers: interviews.answers,
        })
        .from(interviews)
        .where(eq(interviews.caseId, caseId)),
      tx
        .select({
          startedAt: callAttempts.startedAt,
          outcome: callAttempts.outcome,
          note: callAttempts.note,
          number: callAttempts.numberMasked,
        })
        .from(callAttempts)
        .where(eq(callAttempts.caseId, caseId)),
      tx
        .select({
          email: invitations.email,
          status: invitations.status,
          sentAt: invitations.sentAt,
          openedAt: invitations.openedAt,
          completedAt: invitations.completedAt,
        })
        .from(invitations)
        .where(eq(invitations.caseId, caseId)),
      tx
        .select({ type: caseEvents.type, at: caseEvents.at })
        .from(caseEvents)
        .where(eq(caseEvents.caseId, caseId))
        .orderBy(asc(caseEvents.at)),
    ]);
    await this.audit.record(
      tx,
      ctx.tenantId,
      this.audit.fromContext(ctx, {
        action: 'case.subject_exported',
        targetType: 'case',
        targetId: caseId,
        details: { projectId },
      }),
    );
    const views = await tx
      .select({ at: auditLog.at })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, caseId), eq(auditLog.action, 'case.pii_viewed')));
    return {
      generatedAt: new Date().toISOString(),
      case: {
        externalId: c.externalId,
        status: c.status,
        disposition: c.disposition,
        anonymisedAt: c.anonymisedAt,
        sample: this.cases.pii.read(c),
      },
      contacts: cs,
      interviews: ivs,
      calls,
      invitations: invs,
      history: events,
      /** When staff looked at this person's data. */
      personalDataViews: views.map((v) => v.at),
    };
  }
}
