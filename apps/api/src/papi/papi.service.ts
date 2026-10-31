import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { stableStringify, type CompiledQuestionnaire } from '@wansurvey/logic';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { compileRule, maskSample, ruleError } from '../cases/case-logic.js';
import { CasesService } from '../cases/cases.service.js';
import { can, type AuthContext } from '../common/auth-context.js';
import type { InterviewRow } from '../interviews/interviews-repo.js';
import { InterviewsService } from '../interviews/interviews.service.js';
import { PAPI_REPO, type PapiRepo, type PapiTx } from './papi-repo.js';

/**
 * Entries that were keyed and sent, whatever review made of them since (a rejected one is
 * keyed again).
 */
const KEYED = ['submitted', 'in_review', 'approved', 'returned', 'resubmitted'];

export const FormsQuery = z.object({
  questionnaireId: z.uuid().optional(),
  /** Comma-separated case ids, or a case rule; one of them. */
  caseIds: z
    .string()
    .max(20_000)
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(z.array(z.uuid()).max(200).optional()),
  filter: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ResolveBody = z.strictObject({ choice: z.enum(['first', 'second']) });

/** The device id under which supervisors' resolutions are numbered. */
const REVIEW_DEVICE = 'review';

/**
 * Paper interviewing (spec §6.5; decisions P1–P4): printable forms per case, keying by
 * clerks, and double entry with the differences resolved by a supervisor.
 */
@Injectable()
export class PapiService implements OnModuleInit {
  constructor(
    @Inject(PAPI_REPO) private readonly repo: PapiRepo,
    private readonly cases: CasesService,
    private readonly runtime: InterviewsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.runtime.onSubmitted(async (t, row, _disposition, writer) => {
      if (row.mode !== 'PAPI') return;
      await this.afterSubmit(this.repo.extend(t), row, writer);
    });
  }

  /** Forms to print: the questionnaire version and, per case, the cover data (P1, P2). */
  async forms(tx: PapiTx, ctx: AuthContext, projectId: string, q: z.infer<typeof FormsQuery>) {
    if (q.filter) {
      const err = ruleError(q.filter);
      if (err) throw new BadRequestException({ code: 'BAD_FILTER', message: err });
    }
    // Only questionnaires fielded on paper (Q1).
    const list = await this.runtime.questionnairesFor(tx, projectId, 'PAPI');
    const chosen = q.questionnaireId ? list.find((x) => x.id === q.questionnaireId) : list[0];
    if (!chosen) throw new NotFoundException('Questionnaire not found');
    const version = await this.runtime.latestVersion(tx, projectId, chosen.id, 'PAPI');
    const all = can(ctx.memberships, 'cases.read_all', projectId);
    const settings = await this.cases.settings(tx, projectId);
    const pii = await this.cases.piiFields(tx, projectId);
    // Filtered as the forms show the cases: without `pii.view`, personal fields masked.
    const rows = this.cases
      .forRules(
        ctx,
        projectId,
        pii,
        (
          await tx.formCases(projectId, {
            userId: all ? null : ctx.userId,
            ...(q.caseIds?.length ? { caseIds: q.caseIds } : {}),
            questionnaireId: chosen.id,
          })
        ).map((r) => ({ ...r, sample: this.cases.pii.read(r) })),
      )
      .filter(compileRule(q.filter))
      .slice(0, q.caseIds?.length ? 200 : q.limit);
    const auto = this.cases.autoReveal(ctx, projectId, settings);
    const shown = rows.filter((r) => auto && r.assignedTo === ctx.userId);
    if (shown.length) await this.cases.recordAutoViews(tx, ctx, projectId, shown, 'list');
    return {
      questionnaire: chosen,
      version: version.version,
      compiled: version.compiled as CompiledQuestionnaire,
      cases: rows.map((r) => ({
        id: r.id,
        externalId: r.externalId,
        sample: maskSample(
          r.sample as Record<string, unknown>,
          pii,
          auto && r.assignedTo === ctx.userId,
        ),
      })),
    };
  }

  /**
   * Which entry of a case a clerk keys next (P3): the first, the second (by someone else,
   * when the project keys twice), or none.
   */
  async nextPass(tx: PapiTx, ctx: AuthContext, projectId: string, caseId: string) {
    const settings = await this.cases.settings(tx, projectId);
    const done = (await tx.paperInterviews(caseId)).filter((i) => KEYED.includes(i.status));
    const first = done.find((i) => i.entryPass === 1);
    if (!first) return 1;
    if (!settings.papi.doubleEntry || done.some((i) => i.entryPass === 2))
      throw new ConflictException({ code: 'CASE_CLOSED', message: 'This form has been keyed' });
    if (first.interviewerId === ctx.userId)
      throw new ConflictException({
        code: 'SAME_CLERK',
        message: 'The second entry must be keyed by another person',
      });
    return 2;
  }

  /** Finds a case by the id on the form (typed or scanned from the QR code). */
  async lookup(tx: PapiTx, ctx: AuthContext, projectId: string, externalId: string) {
    const c = await tx.caseByExternalId(projectId, externalId.trim());
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No case with this id' });
    const open = (await tx.paperInterviews(c.id)).find((i) => i.status === 'in_progress');
    if (open)
      return {
        caseId: c.id,
        externalId: c.externalId,
        pass: open.entryPass,
        resume: open.interviewerId === ctx.userId ? open.id : null,
      };
    if (c.status === 'withdrawn')
      throw new ConflictException({ code: 'CASE_CLOSED', message: 'This case is withdrawn' });
    const pass = await this.nextPass(tx, ctx, projectId, c.id);
    return { caseId: c.id, externalId: c.externalId, pass, resume: null };
  }

  /**
   * After a paper interview is submitted, with double entry: the first entry leaves the case
   * waiting for the second; the second is compared with the first, variable by variable, and
   * the case stays open until every difference is resolved.
   */
  private async afterSubmit(
    tx: PapiTx,
    row: InterviewRow,
    writer: { tenantId: string; userId: string | null },
  ) {
    // A resubmission after review is not a new entry.
    if (row.mode !== 'PAPI' || !row.caseId || row.submissions > 1) return;
    const settings = await this.cases.settings(tx, row.projectId);
    if (!settings.papi.doubleEntry) return;
    const reopen = () => tx.reopenCase(row.caseId!);
    if (row.entryPass === 1) {
      await reopen();
      await this.cases.events(tx, writer.tenantId, writer.userId, [
        { caseId: row.caseId, type: 'first_entry_done', details: { interviewId: row.id } },
      ]);
      return;
    }
    const first = await tx.firstEntry(row.caseId, KEYED);
    if (!first) return;
    const a = (first.answers ?? {}) as Record<string, unknown>;
    const b = (row.answers ?? {}) as Record<string, unknown>;
    const differ = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => stableStringify(a[k] ?? null) !== stableStringify(b[k] ?? null))
      .sort();
    if (differ.length) {
      await tx.insertMismatches(
        differ.map((variable) => ({
          projectId: row.projectId,
          caseId: row.caseId!,
          firstInterviewId: first.id,
          secondInterviewId: row.id,
          variable,
          firstValue: a[variable] ?? null,
          secondValue: b[variable] ?? null,
        })),
      );
      await reopen();
    }
    await this.cases.events(tx, writer.tenantId, writer.userId, [
      {
        caseId: row.caseId,
        type: differ.length ? 'entries_differ' : 'entries_match',
        details: { first: first.id, second: row.id, differences: differ.length },
      },
    ]);
  }

  mismatches(tx: PapiTx, projectId: string, status: 'open' | 'resolved' | 'all') {
    return tx.mismatches(projectId, status);
  }

  /**
   * A supervisor chooses the right value: it is written to the first entry (the record kept)
   * as a reviewer's change; when no difference remains, the case is finished.
   */
  async resolve(
    tx: PapiTx,
    ctx: AuthContext,
    projectId: string,
    id: string,
    choice: 'first' | 'second',
  ) {
    const m = await tx.lockMismatch(projectId, id);
    if (!m) throw new NotFoundException('Difference not found');
    if (m.status !== 'open')
      throw new ConflictException({ code: 'RESOLVED', message: 'Already resolved' });
    const value = choice === 'first' ? m.firstValue : m.secondValue;
    const now = new Date();
    await tx.resolveMismatch(m.id, { value, by: ctx.userId, at: now });
    if (choice === 'second') {
      await tx.overwriteAnswer(m.firstInterviewId, m.variable, value, now);
      const next = await tx.nextEventSeq(m.firstInterviewId, REVIEW_DEVICE);
      await tx.insertAnswerEvents(m.firstInterviewId, REVIEW_DEVICE, [
        {
          seq: next,
          variable: m.variable,
          oldValue: m.firstValue,
          newValue: value,
          at: now,
          byUserId: ctx.userId,
          source: 'reviewer',
          reason: 'double_entry',
        },
      ]);
    }
    await tx.audit(
      this.audit.fromContext(ctx, {
        action: 'entry.resolved',
        targetType: 'case',
        targetId: m.caseId,
        details: { variable: m.variable, choice },
      }),
    );
    let finished = false;
    if (!(await tx.openMismatches(m.secondInterviewId))) {
      const first = await tx.interview(m.firstInterviewId);
      await tx.finaliseCase(m.caseId, first?.disposition ?? 'COMPLETE');
      await this.cases.events(tx, ctx.tenantId, ctx.userId, [
        { caseId: m.caseId, type: 'entries_resolved', details: { first: m.firstInterviewId } },
      ]);
      finished = true;
    }
    return { resolved: true, value, caseFinished: finished };
  }
}
