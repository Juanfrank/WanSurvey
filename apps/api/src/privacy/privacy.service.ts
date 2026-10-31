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
import { AuditService } from '../audit/audit.service.js';
import { can, type AuthContext } from '../common/auth-context.js';
import { CasesService } from '../cases/cases.service.js';
import { Engine } from '../db/engine.js';
import { PRIVACY_REPO, type PrivacyRepo, type PrivacyTx } from './privacy-repo.js';
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
    private readonly engine: Engine,
    @Inject(PRIVACY_REPO) private readonly repo: PrivacyRepo,
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
  async sealProject(t: PrivacyTx, projectId: string): Promise<number> {
    const pii = [...(await this.cases.piiFields(t, projectId))];
    if (!pii.length) return 0;
    const rows = await t.unsealed(projectId, pii);
    const fields = new Set(pii);
    for (const r of rows) {
      const sealed = this.cases.pii.seal(this.cases.pii.read(r), fields);
      await t.updateCase(r.id, {
        sample: {
          sample: sealed.sample,
          samplePii: sealed.samplePii,
          index: sealed.samplePiiIndex,
        },
      });
    }
    if (rows.length)
      await t.audit({
        action: 'cases.pii_sealed',
        targetType: 'project',
        targetId: projectId,
        details: { cases: rows.length, fields: pii },
      });
    return rows.length;
  }

  async sealAll(): Promise<number> {
    let n = 0;
    for (const tenantId of await this.engine.allTenantIds())
      n += await this.repo.inTenant(tenantId, async (t) => {
        let m = 0;
        for (const id of await t.projectIds()) m += await this.sealProject(t, id);
        return m;
      });
    if (n) this.logger.log(`Sealed personal fields of ${n} cases`);
    return n;
  }

  /** Nightly: cases finished longer ago than their project keeps personal data. */
  async retentionAll(now = new Date()): Promise<number> {
    let n = 0;
    for (const tenantId of await this.engine.allTenantIds()) {
      try {
        n += await this.repo.inTenant(tenantId, async (t) => {
          let m = 0;
          for (const projectId of await t.projectIds()) {
            const days = (await this.cases.settings(t, projectId)).retention.anonymiseAfterDays;
            if (!days) continue;
            const due = await t.dueForRetention(
              projectId,
              new Date(now.getTime() - days * 86_400_000),
              5000,
            );
            for (const id of due) await this.anonymise(t, null, projectId, id, 'retention');
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
    t: PrivacyTx,
    ctx: AuthContext | null,
    projectId: string,
    caseId: string,
    reason: 'retention' | 'request',
    note?: string,
  ): Promise<{ interviews: number; contacts: number }> {
    const c = await t.caseRow(projectId, caseId);
    if (!c) throw new NotFoundException('Case not found');
    const pii = await this.cases.piiFields(t, projectId);
    const withoutPii = (sample: unknown) =>
      Object.fromEntries(
        Object.entries((sample ?? {}) as Record<string, unknown>).filter(([k]) => !pii.has(k)),
      );
    const now = new Date();
    await t.anonymiseCase(caseId, withoutPii(c.sample), now);
    const gone = await t.deleteContacts(caseId);
    await t.scrubCalls(caseId);
    await t.scrubInvitations(caseId);
    const units = await t.unitsOfCase(projectId, caseId, c.frameUnitId);
    for (const u of units) await t.scrubUnit(u.id, withoutPii(u.sample));
    const imports = [c.importId, ...units.map((u) => u.importId)].filter((x): x is string => !!x);
    await this.scrubImportReports(t, projectId, [...new Set(imports)], pii);
    // Scanned pages show the whole form, handwriting and all.
    await t.deleteScanPages(caseId);

    const ivs = await t.interviewsOfCase(caseId);
    const personal = new Set<string>();
    for (const iv of ivs) {
      const names = personalVariables(iv.compiled as CompiledQuestionnaire);
      names.forEach((n) => personal.add(n));
      await t.scrubInterview(iv.id, stripKeys(iv.answers, names), stripKeys(iv.state, names), now);
      await t.eraseHistory(iv.id, [...names]);
    }
    // Double-entry differences keep both keyed values: personal ones go, rosters lose theirs.
    for (const m of await t.mismatches(caseId)) {
      const isGone = personal.has(m.variable);
      const strip = (v: unknown) => (isGone ? null : stripKeys(v, personal));
      await t.setMismatch(m.id, {
        firstValue: strip(m.firstValue),
        secondValue: strip(m.secondValue),
        resolvedValue: strip(m.resolvedValue),
      });
    }
    await this.cases.events(t, ctx?.userId ?? null, [
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
        contacts: gone,
        ...(note ? { note } : {}),
      },
    };
    await t.audit(ctx ? this.audit.fromContext(ctx, entry) : entry);
    return { interviews: ivs.length, contacts: gone };
  }

  /**
   * Blanks the example values of personal columns (contacts and personal sample fields) in
   * the validation reports of these imports.
   */
  private async scrubImportReports(
    t: PrivacyTx,
    projectId: string,
    importIds: string[],
    pii: ReadonlySet<string>,
  ) {
    if (!importIds.length) return;
    const rows = await t.importsToScrub(projectId, importIds);
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
      await t.setImportReport(r.id, { ...report, issues });
    }
  }

  /** Everything held about a case's respondent, for a data subject access request (H3). */
  async subjectData(t: PrivacyTx, ctx: AuthContext, projectId: string, caseId: string) {
    if (!can(ctx.memberships, 'pii.view', projectId))
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You may not see personal data' });
    const c = await t.caseRow(projectId, caseId);
    if (!c) throw new NotFoundException('Case not found');
    const [cs, ivs, calls, invs, events] = await Promise.all([
      t.subjectContacts(caseId),
      t.subjectInterviews(caseId),
      t.subjectCalls(caseId),
      t.subjectInvitations(caseId),
      t.subjectEvents(caseId),
    ]);
    await t.audit(
      this.audit.fromContext(ctx, {
        action: 'case.subject_exported',
        targetType: 'case',
        targetId: caseId,
        details: { projectId },
      }),
    );
    const views = await t.piiViews(caseId);
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
      personalDataViews: views,
    };
  }
}
