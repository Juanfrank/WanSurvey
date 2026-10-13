import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CasesService } from '../cases/cases.service.js';
import type { AuthContext } from '../common/auth-context.js';
import type { Tx } from '../db/database.js';
import {
  cases,
  interviewDevices,
  interviews,
  projects,
  questionnaireVersions,
  questionnaires,
} from '../db/schema.js';
import {
  fieldedIn,
  InterviewsService,
  type InterviewRow,
} from '../interviews/interviews.service.js';
import { DeviceId, type SyncItem } from '../interviews/schemas.js';

export const CheckoutBody = z.strictObject({
  deviceId: DeviceId,
  caseIds: z.array(z.uuid()).min(1).max(200),
  /** The questionnaire for new interviews; the first one in use when left out. */
  questionnaireId: z.uuid().optional(),
});
export type CheckoutBody = z.infer<typeof CheckoutBody>;

export const CheckinBody = z.strictObject({
  deviceId: DeviceId,
  caseIds: z.array(z.uuid()).min(1).max(200),
});

/** An offline start may be dated a little ahead of the server's clock, not more. */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Face-to-face interviewing on devices that go offline (spec §6.3): cases are downloaded to
 * one device (checkout), interviews can start there without a connection and reach the server
 * when it syncs, and cases go back when the device checks them in (D1–D5).
 */
@Injectable()
export class CapiService implements OnModuleInit {
  constructor(
    private readonly cases: CasesService,
    private readonly runtime: InterviewsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.runtime.createOffline = (tx, ctx, deviceId, item) =>
      this.createOffline(tx, ctx, deviceId, item);
  }

  /**
   * Downloads cases to a device: the caller's cases (or free ones in pool mode, which they
   * then hold) that are not finished and not on another device. Returns what the device needs
   * to interview offline: each version once, the case data, and any interview in progress
   * (which moves to this device).
   */
  async checkout(tx: Tx, ctx: AuthContext, projectId: string, body: CheckoutBody) {
    const settings = await this.cases.settings(tx, projectId);
    const [project] = await tx
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new NotFoundException('Project not found');
    // Only questionnaires fielded face to face (Q1).
    const usable = await this.runtime.questionnairesFor(tx, projectId, 'CAPI');
    const qid = usable.find((q) => q.id === body.questionnaireId)?.id ?? usable[0]?.id;
    const latest = qid ? await this.runtime.latestVersion(tx, projectId, qid, 'CAPI') : null;

    const rows = await tx
      .select()
      .from(cases)
      .where(and(eq(cases.projectId, projectId), inArray(cases.id, body.caseIds)))
      .for('update');
    const refused: { caseId: string; code: string }[] = [];
    const out: unknown[] = [];
    const versions = new Map<string, { id: string; version: number; compiled: unknown }>();
    if (latest) versions.set(latest.id, latest);
    const now = new Date();
    for (const id of body.caseIds) {
      const c = rows.find((r) => r.id === id);
      if (!c) {
        refused.push({ caseId: id, code: 'NOT_FOUND' });
        continue;
      }
      if (c.status === 'finalised' || c.status === 'withdrawn') {
        refused.push({ caseId: id, code: 'CASE_CLOSED' });
        continue;
      }
      if (c.checkedOutDevice && c.checkedOutDevice !== body.deviceId) {
        refused.push({ caseId: id, code: 'CHECKED_OUT_ELSEWHERE' });
        continue;
      }
      if (c.callLockUserId && c.callLockUntil && c.callLockUntil > now) {
        refused.push({ caseId: id, code: 'ON_THE_PHONE' });
        continue;
      }
      if (!c.assignedTo && settings.assignmentMode === 'pool') {
        await this.cases.claim(tx, ctx, projectId, c.id);
        c.assignedTo = ctx.userId;
      }
      if (c.assignedTo !== ctx.userId) {
        refused.push({ caseId: id, code: 'NOT_FOUND' });
        continue;
      }
      const [open] = await tx
        .select()
        .from(interviews)
        .where(and(eq(interviews.caseId, c.id), eq(interviews.status, 'in_progress')));
      if (open && open.mode !== 'CAPI') {
        refused.push({ caseId: id, code: 'IN_PROGRESS_OTHER_MODE' });
        continue;
      }
      if (!open && !latest) {
        refused.push({ caseId: id, code: 'NO_PUBLISHED_VERSION' });
        continue;
      }
      await tx
        .update(cases)
        .set({ checkedOutDevice: body.deviceId, checkedOutBy: ctx.userId, checkedOutAt: now })
        .where(eq(cases.id, c.id));
      if (c.checkedOutDevice !== body.deviceId)
        await this.cases.events(tx, ctx.tenantId, ctx.userId, [
          { caseId: c.id, type: 'checked_out', details: { deviceId: body.deviceId } },
        ]);
      let interview: Awaited<ReturnType<InterviewsService['payload']>>['interview'] | null = null;
      let lastSeq = 0;
      if (open) {
        // The interview continues on this device; the other device's copy is refused (I7).
        const [moved] = (await tx
          .update(interviews)
          .set({ deviceId: body.deviceId, interviewerId: ctx.userId, updatedAt: now })
          .where(eq(interviews.id, open.id))
          .returning()) as [InterviewRow];
        await tx
          .insert(interviewDevices)
          .values({ tenantId: ctx.tenantId, interviewId: open.id, deviceId: body.deviceId })
          .onConflictDoNothing();
        const p = await this.runtime.payload(tx, moved, body.deviceId);
        interview = p.interview;
        lastSeq = p.lastSeq;
        if (!versions.has(moved.questionnaireVersionId)) {
          const [v] = await tx
            .select({
              id: questionnaireVersions.id,
              version: questionnaireVersions.version,
              compiled: questionnaireVersions.compiled,
            })
            .from(questionnaireVersions)
            .where(eq(questionnaireVersions.id, moved.questionnaireVersionId));
          versions.set(v!.id, v!);
        }
      }
      const context = await this.runtime.caseContext(
        tx,
        ctx,
        projectId,
        c,
        settings.revealToInterviewers,
      );
      out.push({
        caseId: c.id,
        externalId: c.externalId,
        context,
        questionnaireVersionId: interview?.questionnaireVersionId ?? latest!.id,
        interview,
        lastSeq,
      });
    }
    return {
      project: { id: projectId, name: project.name },
      settings: { capi: settings.capi, shortcuts: settings.shortcuts },
      versions: [...versions.values()].map((v) => ({
        id: v.id,
        version: v.version,
        compiled: v.compiled as CompiledQuestionnaire,
      })),
      cases: out,
      refused,
      serverTime: now.toISOString(),
    };
  }

  /** Gives cases back from a device. Interviews in progress stay as they are on the server. */
  async checkin(tx: Tx, ctx: AuthContext, projectId: string, deviceId: string, ids: string[]) {
    const back = await tx
      .update(cases)
      .set({ checkedOutDevice: null, checkedOutBy: null, checkedOutAt: null })
      .where(
        and(
          eq(cases.projectId, projectId),
          inArray(cases.id, ids),
          eq(cases.checkedOutDevice, deviceId),
          eq(cases.checkedOutBy, ctx.userId),
        ),
      )
      .returning({ id: cases.id });
    await this.cases.events(
      tx,
      ctx.tenantId,
      ctx.userId,
      back.map((b) => ({ caseId: b.id, type: 'checked_in', details: { deviceId } })),
    );
    return { checkedIn: back.map((b) => b.id) };
  }

  /** A supervisor frees a case from a lost or broken device (D5). Audited. */
  async forceRelease(tx: Tx, ctx: AuthContext, projectId: string, caseId: string) {
    const [c] = await tx
      .select({ id: cases.id, device: cases.checkedOutDevice, by: cases.checkedOutBy })
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.projectId, projectId)))
      .for('update');
    if (!c) throw new NotFoundException('Case not found');
    if (!c.device) return { released: false };
    await tx
      .update(cases)
      .set({ checkedOutDevice: null, checkedOutBy: null, checkedOutAt: null })
      .where(eq(cases.id, caseId));
    await this.cases.events(tx, ctx.tenantId, ctx.userId, [
      { caseId, type: 'checkout_released', details: { deviceId: c.device, from: c.by } },
    ]);
    await this.audit.record(
      tx,
      ctx.tenantId,
      this.audit.fromContext(ctx, {
        action: 'case.checkout_released',
        targetType: 'case',
        targetId: caseId,
        details: { deviceId: c.device, from: c.by },
      }),
    );
    return { released: true };
  }

  /**
   * Creates an interview a device started offline (D2): only on a case checked out to that
   * device by the caller, with no other interview in progress, on a published version of the
   * case's project. The id is the device's, so a repeated sync finds it.
   */
  private async createOffline(
    tx: Tx,
    ctx: AuthContext,
    deviceId: string,
    item: SyncItem,
  ): Promise<InterviewRow | string> {
    const start = item.start!;
    if (start.mode !== 'CAPI') return 'BAD_START';
    const [c] = await tx.select().from(cases).where(eq(cases.id, start.caseId)).for('update');
    if (!c || c.checkedOutDevice !== deviceId || c.checkedOutBy !== ctx.userId)
      return 'NOT_THIS_DEVICE';
    if (c.status === 'finalised' || c.status === 'withdrawn') return 'CASE_CLOSED';
    const [open] = await tx
      .select({ id: interviews.id })
      .from(interviews)
      .where(and(eq(interviews.caseId, c.id), eq(interviews.status, 'in_progress')));
    if (open) return 'CASE_IN_PROGRESS';
    const [v] = await tx
      .select({
        id: questionnaireVersions.id,
        version: questionnaireVersions.version,
        compiled: questionnaireVersions.compiled,
      })
      .from(questionnaireVersions)
      .innerJoin(questionnaires, eq(questionnaires.id, questionnaireVersions.questionnaireId))
      .where(
        and(
          eq(questionnaireVersions.id, start.questionnaireVersionId),
          eq(questionnaires.projectId, c.projectId),
          eq(questionnaireVersions.status, 'published'),
        ),
      );
    if (!v) return 'NO_PUBLISHED_VERSION';
    if (!fieldedIn(v.compiled as CompiledQuestionnaire, 'CAPI')) return 'MODE_NOT_IN_QUESTIONNAIRE';
    const settings = await this.cases.settings(tx, c.projectId);
    const context = await this.runtime.caseContext(
      tx,
      ctx,
      c.projectId,
      c,
      settings.revealToInterviewers,
    );
    const startedAt = new Date(
      Math.min(new Date(start.startedAt).getTime(), Date.now() + CLOCK_SKEW_MS),
    );
    const [row] = (await tx
      .insert(interviews)
      .values({
        id: item.id,
        tenantId: ctx.tenantId,
        projectId: c.projectId,
        caseId: c.id,
        questionnaireVersionId: v.id,
        mode: 'CAPI',
        interviewerId: ctx.userId,
        language: start.language,
        context,
        deviceId,
        startedAt,
      })
      .returning()) as [InterviewRow];
    await tx
      .update(cases)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(eq(cases.id, c.id));
    await this.cases.events(tx, ctx.tenantId, ctx.userId, [
      {
        caseId: c.id,
        type: 'interview_started',
        details: { interviewId: row.id, mode: 'CAPI', version: v.version, offline: true },
      },
    ]);
    return row;
  }
}
