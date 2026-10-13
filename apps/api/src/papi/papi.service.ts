import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { stableStringify, type CompiledQuestionnaire } from '@wansurvey/logic';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { compileRule, maskSample, ruleError } from '../cases/case-logic.js';
import { CasesService } from '../cases/cases.service.js';
import { can, type AuthContext } from '../common/auth-context.js';
import type { Tx } from '../db/database.js';
import {
  cases,
  entryMismatches,
  interviewAnswerEvents,
  interviews,
  questionnaires,
  users,
} from '../db/schema.js';
import { InterviewsService, type InterviewRow } from '../interviews/interviews.service.js';

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
    private readonly cases: CasesService,
    private readonly runtime: InterviewsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.runtime.onSubmitted((tx, row, _disposition, writer) => this.afterSubmit(tx, row, writer));
  }

  /** Forms to print: the questionnaire version and, per case, the cover data (P1, P2). */
  async forms(tx: Tx, ctx: AuthContext, projectId: string, q: z.infer<typeof FormsQuery>) {
    if (q.filter) {
      const err = ruleError(q.filter);
      if (err) throw new BadRequestException({ code: 'BAD_FILTER', message: err });
    }
    const list = await tx
      .selectDistinct({ id: questionnaires.id, name: questionnaires.name })
      .from(questionnaires)
      .where(eq(questionnaires.projectId, projectId))
      .orderBy(asc(questionnaires.name));
    const chosen = q.questionnaireId ? list.find((x) => x.id === q.questionnaireId) : list[0];
    if (!chosen) throw new NotFoundException('Questionnaire not found');
    const version = await this.runtime.latestVersion(tx, projectId, chosen.id);
    const all = can(ctx.memberships, 'cases.read_all', projectId);
    const settings = await this.cases.settings(tx, projectId);
    const pii = await this.cases.piiFields(tx, projectId);
    const conds = [eq(cases.projectId, projectId)];
    if (!all) conds.push(eq(cases.assignedTo, ctx.userId));
    if (q.caseIds?.length) conds.push(inArray(cases.id, q.caseIds));
    const rows = (
      await tx
        .select({
          id: cases.id,
          externalId: cases.externalId,
          sample: cases.sample,
          status: cases.status,
          priority: cases.priority,
          modePreference: cases.modePreference,
          assignedTo: cases.assignedTo,
        })
        .from(cases)
        .where(and(...conds))
        .orderBy(asc(cases.externalId))
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

  /** The PAPI interviews of a case, newest first. */
  private async paperInterviews(tx: Tx, caseId: string) {
    return tx
      .select()
      .from(interviews)
      .where(and(eq(interviews.caseId, caseId), eq(interviews.mode, 'PAPI')))
      .orderBy(desc(interviews.startedAt));
  }

  /**
   * Which entry of a case a clerk keys next (P3): the first, the second (by someone else,
   * when the project keys twice), or none.
   */
  async nextPass(tx: Tx, ctx: AuthContext, projectId: string, caseId: string) {
    const settings = await this.cases.settings(tx, projectId);
    const done = (await this.paperInterviews(tx, caseId)).filter((i) => i.status === 'submitted');
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
  async lookup(tx: Tx, ctx: AuthContext, projectId: string, externalId: string) {
    const [c] = await tx
      .select({
        id: cases.id,
        externalId: cases.externalId,
        status: cases.status,
        assignedTo: cases.assignedTo,
      })
      .from(cases)
      .where(and(eq(cases.projectId, projectId), eq(cases.externalId, externalId.trim())));
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No case with this id' });
    const open = (await this.paperInterviews(tx, c.id)).find((i) => i.status === 'in_progress');
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
    tx: Tx,
    row: InterviewRow,
    writer: { tenantId: string; userId: string | null },
  ) {
    // A resubmission after review is not a new entry.
    if (row.mode !== 'PAPI' || !row.caseId || row.submissions > 1) return;
    const settings = await this.cases.settings(tx, row.projectId);
    if (!settings.papi.doubleEntry) return;
    const reopen = () =>
      tx
        .update(cases)
        .set({ status: 'in_progress', disposition: null, updatedAt: new Date() })
        .where(eq(cases.id, row.caseId!));
    if (row.entryPass === 1) {
      await reopen();
      await this.cases.events(tx, writer.tenantId, writer.userId, [
        { caseId: row.caseId, type: 'first_entry_done', details: { interviewId: row.id } },
      ]);
      return;
    }
    const [first] = await tx
      .select()
      .from(interviews)
      .where(
        and(
          eq(interviews.caseId, row.caseId),
          eq(interviews.mode, 'PAPI'),
          eq(interviews.entryPass, 1),
          eq(interviews.status, 'submitted'),
        ),
      );
    if (!first) return;
    const a = (first.answers ?? {}) as Record<string, unknown>;
    const b = (row.answers ?? {}) as Record<string, unknown>;
    const differ = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => stableStringify(a[k] ?? null) !== stableStringify(b[k] ?? null))
      .sort();
    if (differ.length) {
      await tx.insert(entryMismatches).values(
        differ.map((variable) => ({
          tenantId: writer.tenantId,
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

  async mismatches(tx: Tx, projectId: string, status: 'open' | 'resolved' | 'all') {
    return tx
      .select({
        id: entryMismatches.id,
        caseId: entryMismatches.caseId,
        externalId: cases.externalId,
        variable: entryMismatches.variable,
        firstValue: entryMismatches.firstValue,
        secondValue: entryMismatches.secondValue,
        status: entryMismatches.status,
        resolvedValue: entryMismatches.resolvedValue,
        resolvedBy: users.name,
        resolvedAt: entryMismatches.resolvedAt,
        firstInterviewId: entryMismatches.firstInterviewId,
        questionnaireVersionId: interviews.questionnaireVersionId,
      })
      .from(entryMismatches)
      .innerJoin(cases, eq(cases.id, entryMismatches.caseId))
      .innerJoin(interviews, eq(interviews.id, entryMismatches.firstInterviewId))
      .leftJoin(users, eq(users.id, entryMismatches.resolvedBy))
      .where(
        and(
          eq(entryMismatches.projectId, projectId),
          status === 'all' ? sql`true` : eq(entryMismatches.status, status),
        ),
      )
      .orderBy(asc(cases.externalId), asc(entryMismatches.variable))
      .limit(1000);
  }

  /**
   * A supervisor chooses the right value: it is written to the first entry (the record kept)
   * as a reviewer's change; when no difference remains, the case is finished.
   */
  async resolve(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    id: string,
    choice: 'first' | 'second',
  ) {
    const [m] = await tx
      .select()
      .from(entryMismatches)
      .where(and(eq(entryMismatches.id, id), eq(entryMismatches.projectId, projectId)))
      .for('update');
    if (!m) throw new NotFoundException('Difference not found');
    if (m.status !== 'open')
      throw new ConflictException({ code: 'RESOLVED', message: 'Already resolved' });
    const value = choice === 'first' ? m.firstValue : m.secondValue;
    const now = new Date();
    await tx
      .update(entryMismatches)
      .set({ status: 'resolved', resolvedValue: value, resolvedBy: ctx.userId, resolvedAt: now })
      .where(eq(entryMismatches.id, m.id));
    if (choice === 'second') {
      const path = `{${m.variable}}`;
      const statePath = `{answers,${m.variable}}`;
      await tx
        .update(interviews)
        .set({
          answers:
            value === null
              ? sql`${interviews.answers} - ${m.variable}`
              : sql`jsonb_set(${interviews.answers}, ${path}::text[], ${JSON.stringify(value)}::jsonb, true)`,
          state:
            value === null
              ? sql`jsonb_set(${interviews.state}, '{answers}', (${interviews.state} -> 'answers') - ${m.variable}, true)`
              : sql`jsonb_set(${interviews.state}, ${statePath}::text[], ${JSON.stringify(value)}::jsonb, true)`,
          updatedAt: now,
        })
        .where(eq(interviews.id, m.firstInterviewId));
      const [{ next }] = (await tx
        .select({ next: sql<number>`coalesce(max(${interviewAnswerEvents.seq}), 0)::int + 1` })
        .from(interviewAnswerEvents)
        .where(
          and(
            eq(interviewAnswerEvents.interviewId, m.firstInterviewId),
            eq(interviewAnswerEvents.deviceId, REVIEW_DEVICE),
          ),
        )) as [{ next: number }];
      await tx.insert(interviewAnswerEvents).values({
        tenantId: ctx.tenantId,
        interviewId: m.firstInterviewId,
        deviceId: REVIEW_DEVICE,
        seq: next,
        variable: m.variable,
        oldValue: m.firstValue,
        newValue: value,
        at: now,
        byUserId: ctx.userId,
        source: 'reviewer',
        reason: 'double_entry',
      });
    }
    await this.audit.record(
      tx,
      ctx.tenantId,
      this.audit.fromContext(ctx, {
        action: 'entry.resolved',
        targetType: 'case',
        targetId: m.caseId,
        details: { variable: m.variable, choice },
      }),
    );
    const [left] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(entryMismatches)
      .where(
        and(
          eq(entryMismatches.secondInterviewId, m.secondInterviewId),
          eq(entryMismatches.status, 'open'),
        ),
      );
    let finished = false;
    if (!left!.n) {
      const [first] = await tx
        .select({ disposition: interviews.disposition })
        .from(interviews)
        .where(eq(interviews.id, m.firstInterviewId));
      await tx
        .update(cases)
        .set({ status: 'finalised', disposition: first?.disposition ?? 'COMPLETE', updatedAt: now })
        .where(eq(cases.id, m.caseId));
      await this.cases.events(tx, ctx.tenantId, ctx.userId, [
        { caseId: m.caseId, type: 'entries_resolved', details: { first: m.firstInterviewId } },
      ]);
      finished = true;
    }
    return { resolved: true, value, caseFinished: finished };
  }
}
