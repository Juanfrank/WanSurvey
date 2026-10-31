import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  createInterview,
  respondentFromCase,
  verifySubmission,
  type CompiledQuestionnaire,
  type InterviewOptions,
} from '@wansurvey/logic';
import type { ContainerItem, Mode, ProjectSettings } from '@wansurvey/schema';
import { AuditService } from '../audit/audit.service.js';
import { maskContact, maskSample } from '../cases/case-logic.js';
import { CasesService } from '../cases/cases.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { closedCode } from '../questionnaires/state.js';
import { type CaseFull, type InterviewRow, type InterviewsTx } from './interviews-repo.js';
import type { StartBody, SubmitBody, SyncItem } from './schemas.js';
import { compiledCache, Lru } from './compiled-cache.js';

export type { InterviewRow } from './interviews-repo.js';

/** What `interviews.context` holds: the case data the interview was given at start. */
export interface StoredContext {
  externalId?: string;
  case?: Record<string, unknown>;
  contacts?: { type: string; value: string; label: string | null }[];
  /** The link's parameters (web surveys). */
  params?: Record<string, string>;
  [key: string]: unknown;
}

/** A version's number and questionnaire, by version id (immutable rows), per process. */
const versionCache = new Lru<string, { version: number; questionnaireId: string }>(200);

/** Statuses in which the interviewer can still change answers: open, or returned by review. */
export const EDITABLE = new Set(['in_progress', 'returned']);

/** Whether a version is fielded in a mode; versions published before modes existed are in all (Q1). */
export function fieldedIn(compiled: CompiledQuestionnaire, mode: string): boolean {
  const modes = (compiled.questionnaire as { modes?: string[] }).modes;
  return !modes?.length || modes.includes(mode);
}

/** Who writes: a signed-in person, or a respondent through a link (no user). */
export interface Writer {
  tenantId: string;
  userId: string | null;
  ctx: AuthContext | null;
}

/** Runs inside the submitting transaction, after the interview is marked submitted. */
export type SubmitContributor = (
  t: InterviewsTx,
  row: InterviewRow,
) => Promise<Partial<Pick<InterviewRow, 'flags' | 'sampled'>>>;

export type SubmitHook = (
  t: InterviewsTx,
  row: InterviewRow,
  disposition: string,
  writer: Writer,
) => Promise<void>;

/**
 * The interview runtime shared by every mode: start or resume on a case, apply numbered
 * changes from a device, and accept a submission after re-running the logic on the server.
 * CATI, CAPI checkout, CAWI links and PAPI entry build on it.
 */
@Injectable()
export class InterviewsService {
  private readonly hooks: SubmitHook[] = [];
  private readonly contributors: SubmitContributor[] = [];

  constructor(
    private readonly audit: AuditService,
    private readonly cases: CasesService,
  ) {}

  /** Set by the CAPI module: creates an interview a device started offline (D2). */
  createOffline?: (
    t: InterviewsTx,
    ctx: AuthContext,
    deviceId: string,
    item: SyncItem,
  ) => Promise<InterviewRow | string>;

  /** Other modules react to submissions (close a call, mark an invitation, compare entries). */
  onSubmitted(hook: SubmitHook) {
    this.hooks.push(hook);
  }

  /**
   * Fields other modules add to the submission's own update (the review flags), so they are
   * written by the same statement instead of a second update after it.
   */
  onSubmitting(fn: SubmitContributor) {
    this.contributors.push(fn);
  }

  /**
   * Starts an interview on a case the caller holds (taking it in pool mode), or resumes the
   * one in progress. Idempotent on the client's id.
   */
  async start(
    tx: InterviewsTx,
    ctx: AuthContext,
    projectId: string,
    body: StartBody,
    opts: { entryPass?: number | undefined } = {},
  ): Promise<InterviewRow> {
    const t = tx;
    const settings = await this.cases.settings(t, projectId);
    const c = await t.lockCase(projectId, body.caseId);
    if (!c) throw new NotFoundException('Case not found');
    if (c.status === 'finalised' || c.status === 'withdrawn')
      throw new ConflictException({
        code: 'CASE_CLOSED',
        message: 'This case is finished or withdrawn',
      });
    if (c.checkedOutDevice && c.checkedOutDevice !== body.deviceId)
      throw new ConflictException({
        code: 'CHECKED_OUT_ELSEWHERE',
        message: 'This case is downloaded to another device',
      });
    // C10: in pool mode, starting on a free case takes it.
    if (!c.assignedTo && settings.assignmentMode === 'pool') {
      await this.cases.claim(t, ctx, projectId, c.id);
      c.assignedTo = ctx.userId;
    }
    const pass = opts.entryPass ?? 1;
    // A second data-entry pass is keyed by another clerk, who does not hold the case.
    if (pass === 1 && c.assignedTo !== ctx.userId) throw new NotFoundException('Case not found');

    const open = await t.openInterview(c.id);
    let row: InterviewRow;
    if (open) {
      if (open.entryPass !== pass)
        throw new ConflictException({
          code: 'ENTRY_IN_PROGRESS',
          message: 'Another entry of this case is in progress',
        });
      // An interview open in another mode (a respondent on the web) is not taken over.
      if (open.mode !== body.mode)
        throw new ConflictException({
          code: 'IN_PROGRESS_OTHER_MODE',
          message: 'This case has an interview in progress in another mode',
          mode: open.mode,
        });
      // Resuming: the person holding the case now works it, on this device.
      row = await t.takeOver(open.id, {
        deviceId: body.deviceId,
        interviewerId: ctx.userId,
        now: new Date(),
      });
    } else {
      if (await t.interview(body.id))
        throw new ConflictException({ code: 'ID_IN_USE', message: 'Interview id in use' });
      // A case is interviewed with the questionnaire it belongs to.
      if (c.questionnaireId && c.questionnaireId !== body.questionnaireId)
        throw new ConflictException({
          code: 'OTHER_QUESTIONNAIRE',
          message: 'This case belongs to another questionnaire',
        });
      const version = await this.latestVersion(t, projectId, body.questionnaireId, body.mode);
      const context = await this.caseContext(t, ctx, projectId, c, settings.revealToInterviewers);
      row = await t.insertInterview({
        id: body.id,
        projectId,
        caseId: c.id,
        questionnaireVersionId: version.id,
        mode: body.mode,
        interviewerId: ctx.userId,
        language:
          body.language ??
          (version.compiled as CompiledQuestionnaire).questionnaire.defaultLanguage,
        context,
        deviceId: body.deviceId,
        entryPass: pass,
      });
      await t.setCaseInProgress(c.id);
      await this.cases.events(t, ctx.tenantId, ctx.userId, [
        {
          caseId: c.id,
          type: 'interview_started',
          details: { interviewId: row.id, mode: body.mode, version: version.version, pass },
        },
      ]);
    }
    await t.ensureDevice(row.id, body.deviceId);
    return row;
  }

  /**
   * Applies batches of numbered changes. Numbers already acknowledged are skipped and
   * nothing after a gap is taken, so replays are harmless. `authorize` decides per interview
   * (an error code, or null); `create` makes an interview the server has not seen.
   */
  async sync(
    tx: InterviewsTx,
    writer: Writer,
    deviceId: string,
    items: SyncItem[],
    authorize: (row: InterviewRow) => string | null,
    create?: (item: SyncItem) => Promise<InterviewRow | string>,
    /** An interview the caller already locked in this transaction (one fewer statement). */
    locked?: InterviewRow,
  ) {
    const t = tx;
    const acks: Record<string, number> = {};
    const errors: Record<string, string> = {};
    /** The state's new version, for the interviews whose snapshot was written. */
    const versions: Record<string, number> = {};
    // Rows are locked in one global order (by id), so two devices syncing overlapping
    // interviews at once wait for each other instead of deadlocking.
    const ordered = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const item of ordered) {
      let row = locked?.id === item.id ? locked : await t.interview(item.id, true);
      if (!row && item.start && create) {
        const made = await create(item);
        if (typeof made === 'string') {
          errors[item.id] = made;
          continue;
        }
        row = made;
      }
      if (!row) {
        errors[item.id] = 'NOT_FOUND';
        continue;
      }
      const refused = authorize(row);
      if (refused) {
        errors[item.id] = refused;
        continue;
      }
      if (row.deviceId !== deviceId) {
        errors[item.id] = 'NOT_THIS_DEVICE';
        continue;
      }
      let last = await t.touchDevice(row.id, deviceId);
      if (!EDITABLE.has(row.status)) {
        acks[item.id] = last;
        errors[item.id] = 'SUBMITTED';
        continue;
      }
      // Only the run that continues from the acknowledged number is taken.
      const ops = [...item.ops].filter((o) => o.seq > last).sort((a, b) => a.seq - b.seq);
      const run: typeof ops = [];
      for (const o of ops) {
        if (o.seq !== last + run.length + 1) break;
        run.push(o);
      }
      const answers = run.filter((o) => o.kind === 'answer');
      const para = run.filter((o) => o.kind === 'paradata');
      await t.insertAnswerEvents(
        row.id,
        deviceId,
        answers.map((o) => ({
          seq: o.seq,
          variable: o.variable,
          oldValue: o.oldValue ?? null,
          newValue: o.newValue ?? null,
          at: new Date(o.at),
          byUserId: o.source === 'system' ? null : writer.userId,
          source: o.source,
          reason: o.reason ?? null,
        })),
      );
      await t.insertParadata(
        row.id,
        deviceId,
        para.map((o) => ({
          seq: o.seq,
          type: o.type,
          at: new Date(o.at),
          monotonicMs: o.monotonicMs ?? null,
          payload: o.payload,
        })),
      );
      last += run.length;
      // The snapshot belongs to the end of the batch: keep it only when nothing was missed and
      // the batch brought new changes (a late or repeated batch carries an older snapshot). A
      // batch with no changes at all is a snapshot alone (a scanned form with no marks).
      const fresh = run.length === ops.length && (run.length > 0 || item.ops.length === 0);
      // A snapshot built on an older version than the server's is refused, unless this device
      // wrote the newer one itself (its answer was lost): its copy then includes it.
      const stale =
        fresh &&
        !!item.state &&
        item.baseVersion !== undefined &&
        item.baseVersion !== row.stateVersion &&
        row.stateDevice !== deviceId;
      const hasState = fresh && !!item.state && !stale;
      // The interview and the device's number are written by one statement.
      await t.finishSync({
        id: row.id,
        device: deviceId,
        seq: last,
        touch: fresh && (!!item.state || run.length > 0),
        hasState,
        state: item.state ?? null,
        position: item.position ?? null,
        active: item.activeMs ?? null,
        total: item.totalMs ?? null,
      });
      acks[item.id] = last;
      if (hasState) versions[item.id] = row.stateVersion + 1;
      if (stale) errors[item.id] = 'STALE_STATE';
    }
    return { acks, errors, versions, serverTime: new Date().toISOString() };
  }

  /**
   * Submits a finished interview: everything synced, the server's own run of the stored
   * answers reaches the end on the same path, then the case is finalised and hooks run.
   */
  /** `known.lastSeq`: the device's last change number, when the caller read it with the lock. */
  async submit(
    tx: InterviewsTx,
    row: InterviewRow,
    body: SubmitBody,
    writer: Writer,
    known: { lastSeq?: number } = {},
  ) {
    const t = tx;
    if (!EDITABLE.has(row.status))
      throw new ConflictException({ code: 'SUBMITTED', message: 'Already submitted' });
    if (row.deviceId !== body.deviceId)
      throw new ConflictException({
        code: 'NOT_THIS_DEVICE',
        message: 'This interview is open on another device',
      });
    const lastSeq = known.lastSeq ?? (await t.deviceSeq(row.id, body.deviceId));
    if ((lastSeq ?? 0) < body.seq)
      throw new ConflictException({
        code: 'NOT_SYNCED',
        message: 'Some changes have not reached the server yet',
      });
    const compiled = await this.compiledOf(t, row.questionnaireVersionId);
    const opts = this.engineOptions(row);
    const state = row.state as InterviewOptions['state'];
    const session = createInterview(compiled, { ...opts, state });
    const status = session.status();
    if (status.state === 'in_progress')
      throw new ConflictException({
        code: 'NOT_COMPLETE',
        message: 'The interview has not reached its end',
      });
    const check = verifySubmission(compiled, opts, session.getAnswers(), body.path);
    if (!check.match)
      throw new UnprocessableEntityException({
        code: 'PATH_MISMATCH',
        message: 'The answers lead to a different path on the server',
        unexpected: check.unexpected.slice(0, 50),
        missing: check.missing.slice(0, 50),
        offPathAnswers: check.offPathAnswers.slice(0, 50),
      });
    const disposition = status.disposition ?? 'COMPLETE';
    const extra = {};
    for (const c of this.contributors) Object.assign(extra, await c(t, row));
    const done = await t.markSubmitted(row.id, {
      extra,
      disposition,
      endedAt: row.endedAt,
      submissions: row.submissions,
    });
    if (row.caseId) {
      await this.finaliseCase(t, writer, row.caseId, disposition, {
        interviewId: row.id,
        disposition,
      });
    }
    for (const hook of this.hooks) await hook(t, done, disposition, writer);
    if (writer.ctx)
      await t.audit(
        this.audit.fromContext(writer.ctx, {
          action: 'interview.submitted',
          targetType: 'interview',
          targetId: row.id,
          details: { caseId: row.caseId, disposition },
        }),
      );
    return { status: done.status, disposition };
  }

  /**
   * Marks a case finished with a disposition, unless a hook keeps it open (double entry).
   * Hooks that need the case open set it back; see the PAPI module.
   */
  async finaliseCase(
    tx: InterviewsTx,
    writer: Writer,
    caseId: string,
    disposition: string,
    details: Record<string, unknown>,
  ) {
    const t = tx;
    await t.finaliseCase(caseId, disposition);
    await this.cases.events(t, writer.tenantId, writer.userId, [
      { caseId, type: 'interview_submitted', details },
    ]);
  }

  /**
   * The version in use of a questionnaire, for a new fill; with `mode`, refused unless the
   * questionnaire is fielded in that mode (Q1). A disabled or completed questionnaire takes no
   * new fills, unless `readOnly` (to show what an existing fill uses).
   */
  async latestVersion(
    tx: InterviewsTx,
    projectId: string,
    qid: string,
    mode?: Mode,
    opts: { readOnly?: boolean } = {},
  ) {
    const t = tx;
    // The compiled form comes from the cache (versions never change): reading it here would
    // fetch and decode the whole questionnaire on every start.
    const found = await t.latestPublished(projectId, qid);
    const v = found && { ...found, compiled: await this.compiledOf(t, found.id) };
    if (!v)
      throw new BadRequestException({
        code: 'NO_PUBLISHED_VERSION',
        message: 'This questionnaire has no version in use',
      });
    if (mode && !fieldedIn(v.compiled as CompiledQuestionnaire, mode))
      throw new ConflictException({
        code: 'MODE_NOT_IN_QUESTIONNAIRE',
        message: `This questionnaire is not fielded in ${mode}`,
        mode,
      });
    const closed = opts.readOnly ? null : closedCode(v.state);
    if (closed)
      throw new ConflictException({
        code: closed,
        message:
          closed === 'QUESTIONNAIRE_DISABLED'
            ? 'This questionnaire is disabled'
            : 'This questionnaire is completed',
      });
    return v;
  }

  /** Questionnaires of a project whose version in use is fielded in `mode`, by name. */
  async questionnairesFor(tx: InterviewsTx, projectId: string, mode: Mode) {
    const rows = await tx.questionnairesWithModes(projectId);
    return rows
      .filter((r) => (Array.isArray(r.modes) ? r.modes.includes(mode) : true))
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Records that the device is on the interview; returns its last acknowledged change. */
  async touchDevice(tx: InterviewsTx, tenantId: string, interviewId: string, deviceId: string) {
    return tx.touchDevice(interviewId, deviceId);
  }

  /** The interview, locked for this transaction. */
  async locked(tx: InterviewsTx, id: string): Promise<InterviewRow | undefined> {
    return (await tx.interview(id, true)) ?? undefined;
  }

  /** A version's number and questionnaire (immutable, so cached like the compiled form). */
  async versionOf(tx: InterviewsTx, versionId: string) {
    const hit = versionCache.get(versionId);
    if (hit) return hit;
    const v = await tx.versionBrief(versionId);
    if (v) versionCache.set(versionId, v);
    return v ?? undefined;
  }

  /**
   * A version's compiled questionnaire. Versions never change once written (a trigger refuses
   * updates), so they are kept in memory, the most used first: the respondent page, every sync
   * and every submit need it, and it is the largest thing they read. Ids reach here only from
   * rows the caller's tenant can see (RLS), so the cache never crosses organisations.
   */
  async compiledOf(tx: InterviewsTx, versionId: string) {
    const hit = compiledCache.get(versionId);
    if (hit) return hit;
    const compiled = (await tx.compiledRaw(versionId))!;
    compiledCache.set(versionId, compiled);
    return compiled;
  }

  /** Case data for the engine and the screen, masked as the interviewer would see it. */
  async caseContext(
    tx: InterviewsTx,
    ctx: AuthContext | null,
    projectId: string,
    c: CaseFull,
    reveal: boolean,
  ) {
    const t = tx;
    const show = !!ctx && reveal && this.cases.canSeePii(ctx, projectId);
    const pii = await this.cases.piiFields(t, projectId);
    const cs = await t.contacts(c.id);
    if (show && ctx)
      await this.cases.recordAutoViews(
        t,
        ctx,
        projectId,
        [{ id: c.id, externalId: c.externalId }],
        'detail',
      );
    return {
      externalId: c.externalId,
      case: maskSample(this.cases.pii.read(c), pii, show),
      contacts: cs.map((x) => maskContact(x, show)),
    };
  }

  /**
   * The interview's case data as the engine and the screen use it: a web respondent's record
   * is kept sealed (`casePii`, see `CawiService`) and opened here.
   */
  contextOf(row: Pick<InterviewRow, 'context'>): StoredContext {
    const { casePii, ...context } = row.context as StoredContext & { casePii?: string };
    if (!casePii) return context;
    return { ...context, case: { ...context.case, ...this.cases.pii.open(casePii) } };
  }

  engineOptions(row: InterviewRow): Omit<InterviewOptions, 'state'> {
    const context = this.contextOf(row);
    return {
      mode: row.mode as Mode,
      language: row.language,
      seed: row.id,
      now: () => row.startedAt,
      // The link's parameters answer their questions here too, as on the respondent's device.
      context: {
        case: context.case ?? {},
        respondent: respondentFromCase(context.case ?? {}),
        ...(context.params ? { params: context.params } : {}),
      },
    };
  }

  /**
   * Everything a device needs to show and continue an interview. `settings` is the project's,
   * when the caller has already read them (one read of the project per request).
   */
  async payload(
    tx: InterviewsTx,
    row: InterviewRow,
    deviceId: string,
    settings?: ProjectSettings,
    lastSeq?: number,
  ) {
    const t = tx;
    const seq = lastSeq !== undefined ? lastSeq : await t.deviceSeq(row.id, deviceId);
    const v = await this.versionOf(t, row.questionnaireVersionId);
    const compiled = await this.compiledOf(t, row.questionnaireVersionId);
    const who = row.interviewerId ? await t.userName(row.interviewerId) : null;
    return {
      interview: {
        id: row.id,
        projectId: row.projectId,
        caseId: row.caseId,
        questionnaireId: v!.questionnaireId,
        questionnaireVersionId: row.questionnaireVersionId,
        version: v!.version,
        mode: row.mode,
        language: row.language,
        status: row.status,
        disposition: row.disposition,
        startedAt: row.startedAt,
        state: row.state,
        stateVersion: row.stateVersion,
        /** This device wrote the snapshot last: its own copy includes it. */
        ownState: row.stateDevice === deviceId,
        activeMs: row.activeMs,
        totalMs: row.totalMs,
        deviceId: row.deviceId,
        entryPass: row.entryPass,
        interviewer: who,
      },
      context: this.contextOf(row),
      compiled,
      settings: await (
        settings ? Promise.resolve(settings) : this.cases.settings(t, row.projectId)
      ).then((x) => ({ capi: x.capi, shortcuts: x.shortcuts })),
      lastSeq: seq ?? 0,
      serverTime: new Date().toISOString(),
    };
  }
}

/** Variables of questions marked personal (masked in histories without `pii.view`). */
export function personalVariables(compiled: CompiledQuestionnaire): Set<string> {
  const out = new Set<string>();
  const walk = (items: ContainerItem[]) => {
    for (const it of items) {
      if (it.kind === 'question' && it.personal) out.add(it.name);
      if ('items' in it && Array.isArray(it.items)) walk(it.items);
    }
  };
  for (const s of compiled.questionnaire.sections) walk(s.items);
  return out;
}
