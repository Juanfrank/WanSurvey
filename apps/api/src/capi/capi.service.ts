import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CasesService } from '../cases/cases.service.js';
import { can, type AuthContext } from '../common/auth-context.js';
import type { InterviewRow, InterviewsTx } from '../interviews/interviews-repo.js';
import { fieldedIn, InterviewsService } from '../interviews/interviews.service.js';
import { DeviceId, type SyncItem } from '../interviews/schemas.js';
import { closedCode } from '../questionnaires/state.js';

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
    this.runtime.createOffline = (t, ctx, deviceId, item) =>
      this.createOffline(t, ctx, deviceId, item);
  }

  /**
   * Downloads cases to a device: the caller's cases (or free ones in pool mode, which they
   * then hold) that are not finished and not on another device. Returns what the device needs
   * to interview offline: each version once, the case data, and any interview in progress
   * (which moves to this device).
   */
  async checkout(t: InterviewsTx, ctx: AuthContext, projectId: string, body: CheckoutBody) {
    const settings = await this.cases.settings(t, projectId);
    const projectName = await t.projectName(projectId);
    if (projectName === null) throw new NotFoundException('Project not found');
    // Only questionnaires fielded face to face (Q1).
    const usable = await this.runtime.questionnairesFor(t, projectId, 'CAPI');
    const qid = usable.find((q) => q.id === body.questionnaireId)?.id ?? usable[0]?.id;
    // Each case is interviewed with its own questionnaire; the one asked for is for the rest.
    const latestOf = new Map<string, Awaited<ReturnType<InterviewsService['latestVersion']>>>();
    const latestFor = async (q: string | null | undefined) => {
      const id = q ? usable.find((u) => u.id === q)?.id : qid;
      if (!id) return null;
      if (!latestOf.has(id))
        latestOf.set(id, await this.runtime.latestVersion(t, projectId, id, 'CAPI'));
      return latestOf.get(id) ?? null;
    };

    const rows = await t.lockCases(projectId, body.caseIds);
    const refused: { caseId: string; code: string }[] = [];
    const out: unknown[] = [];
    const versions = new Map<string, { id: string; version: number; compiled: unknown }>();
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
        await this.cases.claim(t, ctx, projectId, c.id);
        c.assignedTo = ctx.userId;
      }
      if (c.assignedTo !== ctx.userId) {
        refused.push({ caseId: id, code: 'NOT_FOUND' });
        continue;
      }
      const open = await t.openInterview(c.id);
      if (open && open.mode !== 'CAPI') {
        refused.push({ caseId: id, code: 'IN_PROGRESS_OTHER_MODE' });
        continue;
      }
      const latest = await latestFor(c.questionnaireId);
      if (!open && !latest) {
        refused.push({ caseId: id, code: 'NO_PUBLISHED_VERSION' });
        continue;
      }
      if (latest && !open) versions.set(latest.id, latest);
      await t.setCheckout(c.id, { device: body.deviceId, by: ctx.userId, at: now });
      if (c.checkedOutDevice !== body.deviceId)
        await this.cases.events(t, ctx.tenantId, ctx.userId, [
          { caseId: c.id, type: 'checked_out', details: { deviceId: body.deviceId } },
        ]);
      let interview: Awaited<ReturnType<InterviewsService['payload']>>['interview'] | null = null;
      let lastSeq = 0;
      if (open) {
        // The interview continues on this device; the other device's copy is refused (I7).
        const moved = await t.takeOver(open.id, {
          deviceId: body.deviceId,
          interviewerId: ctx.userId,
          now,
        });
        await t.ensureDevice(open.id, body.deviceId);
        const p = await this.runtime.payload(t, moved, body.deviceId);
        interview = p.interview;
        lastSeq = p.lastSeq;
        if (!versions.has(moved.questionnaireVersionId)) {
          const v = await t.versionRow(moved.questionnaireVersionId);
          versions.set(v!.id, v!);
        }
      }
      const context = await this.runtime.caseContext(
        t,
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
      project: { id: projectId, name: projectName },
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
  async checkin(
    t: InterviewsTx,
    ctx: AuthContext,
    projectId: string,
    deviceId: string,
    ids: string[],
  ) {
    const back = await t.checkIn(projectId, ids, deviceId, ctx.userId);
    await this.cases.events(
      t,
      ctx.tenantId,
      ctx.userId,
      back.map((id) => ({ caseId: id, type: 'checked_in', details: { deviceId } })),
    );
    return { checkedIn: back };
  }

  /** A supervisor frees a case from a lost or broken device (D5). Audited. */
  async forceRelease(t: InterviewsTx, ctx: AuthContext, projectId: string, caseId: string) {
    const c = await t.lockCase(projectId, caseId);
    if (!c) throw new NotFoundException('Case not found');
    const device = c.checkedOutDevice;
    if (!device) return { released: false };
    await t.setCheckout(caseId, null);
    await this.cases.events(t, ctx.tenantId, ctx.userId, [
      { caseId, type: 'checkout_released', details: { deviceId: device, from: c.checkedOutBy } },
    ]);
    await t.audit(
      this.audit.fromContext(ctx, {
        action: 'case.checkout_released',
        targetType: 'case',
        targetId: caseId,
        details: { deviceId: device, from: c.checkedOutBy },
      }),
    );
    return { released: true };
  }

  private async createOffline(
    t: InterviewsTx,
    ctx: AuthContext,
    deviceId: string,
    item: SyncItem,
  ): Promise<InterviewRow | string> {
    const start = item.start!;
    if (start.mode !== 'CAPI') return 'BAD_START';
    const c = await t.lockCaseById(start.caseId);
    if (!c || c.checkedOutDevice !== deviceId || c.checkedOutBy !== ctx.userId)
      return 'NOT_THIS_DEVICE';
    // Downloading needed the permission; interviewing still does (it may have been taken away).
    if (!can(ctx.memberships, 'interviews.conduct', c.projectId)) return 'NOT_FOUND';
    if (c.status === 'finalised' || c.status === 'withdrawn') return 'CASE_CLOSED';
    if (await t.openInterview(c.id)) return 'CASE_IN_PROGRESS';
    const v = await t.publishedVersion(c.projectId, start.questionnaireVersionId);
    if (!v) return 'NO_PUBLISHED_VERSION';
    // As when starting online: the case's own questionnaire, and one that takes new fills.
    if (c.questionnaireId && c.questionnaireId !== v.questionnaireId) return 'OTHER_QUESTIONNAIRE';
    const closed = closedCode(v.state);
    if (closed) return closed;
    if (!fieldedIn(v.compiled as CompiledQuestionnaire, 'CAPI')) return 'MODE_NOT_IN_QUESTIONNAIRE';
    const settings = await this.cases.settings(t, c.projectId);
    const context = await this.runtime.caseContext(
      t,
      ctx,
      c.projectId,
      c,
      settings.revealToInterviewers,
    );
    const startedAt = new Date(
      Math.min(new Date(start.startedAt).getTime(), Date.now() + CLOCK_SKEW_MS),
    );
    const row = await t.insertInterview({
      id: item.id,
      projectId: c.projectId,
      caseId: c.id,
      questionnaireVersionId: v.id,
      mode: 'CAPI',
      interviewerId: ctx.userId,
      language: start.language,
      context,
      deviceId,
      startedAt,
    });
    await t.setCaseInProgress(c.id);
    await this.cases.events(t, ctx.tenantId, ctx.userId, [
      {
        caseId: c.id,
        type: 'interview_started',
        details: { interviewId: row.id, mode: 'CAPI', version: v.version, offline: true },
      },
    ]);
    return row;
  }
}
