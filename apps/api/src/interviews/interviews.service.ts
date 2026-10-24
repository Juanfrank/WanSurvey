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
import { and, asc, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { maskContact, maskSample } from '../cases/case-logic.js';
import { CasesService } from '../cases/cases.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { closedCode } from '../questionnaires/state.js';
import { Prepared, type Tx } from '../db/database.js';
import {
  cases,
  contacts,
  interviewAnswerEvents,
  interviewDevices,
  interviewParadata,
  interviews,
  questionnaireVersions,
  questionnaires,
  users,
} from '../db/schema.js';
import type { StartBody, SubmitBody, SyncItem } from './schemas.js';
import { compiledCache, Lru } from './compiled-cache.js';

export type InterviewRow = typeof interviews.$inferSelect;

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

// The queries every device and respondent request runs, built once (see Prepared).
const lockInterview = new Prepared<InterviewRow>(
  (tx) =>
    tx
      .select()
      .from(interviews)
      .where(eq(interviews.id, sql.placeholder('id')))
      .for('update'),
  getTableColumns(interviews),
);
const deviceSeq = new Prepared<{ lastSeq: number }>(
  (tx) =>
    tx
      .select({ lastSeq: interviewDevices.lastSeq })
      .from(interviewDevices)
      .where(
        and(
          eq(interviewDevices.interviewId, sql.placeholder('id')),
          eq(interviewDevices.deviceId, sql.placeholder('device')),
        ),
      ),
  { lastSeq: interviewDevices.lastSeq },
);
const touchDevice = new Prepared<{ lastSeq: number }>(
  (tx) =>
    tx
      .insert(interviewDevices)
      .values({
        tenantId: sql.placeholder('tenantId'),
        interviewId: sql.placeholder('id'),
        deviceId: sql.placeholder('device'),
      })
      .onConflictDoUpdate({
        target: [interviewDevices.interviewId, interviewDevices.deviceId],
        set: { updatedAt: sql`now()` },
      })
      .returning({ lastSeq: interviewDevices.lastSeq }),
  { lastSeq: interviewDevices.lastSeq },
);
/**
 * The end of a sync: the interview's snapshot and times (when `touch`; only the fields sent)
 * and the device's acknowledged number, in one statement. A new snapshot bumps the state's
 * version and keeps the codes given to "other" texts (`<VAR>_CODE`, not in the snapshot)
 * whose text is unchanged.
 */
const finishSync = new Prepared<never>(
  () => sql`
    with i as (
      update interviews set
        state = case when ${sql.placeholder('hasState')} then ${sql.placeholder('state')}::jsonb else state end,
        answers = case when ${sql.placeholder('hasState')} then coalesce((
            select jsonb_object_agg(k.key, k.value) from jsonb_each(answers) k
            where k.key like '%\\_CODE'
              and ${sql.placeholder('answers')}::jsonb -> (left(k.key, -5) || '_OTHER')
                = answers -> (left(k.key, -5) || '_OTHER')
          ), '{}'::jsonb) || ${sql.placeholder('answers')}::jsonb else answers end,
        state_version = state_version + case when ${sql.placeholder('hasState')} then 1 else 0 end,
        state_device = case when ${sql.placeholder('hasState')} then ${sql.placeholder('device')}::text else state_device end,
        position = case when ${sql.placeholder('hasState')} then ${sql.placeholder('position')}::text else position end,
        active_ms = coalesce(${sql.placeholder('active')}::int, active_ms),
        total_ms = coalesce(${sql.placeholder('total')}::int, total_ms),
        updated_at = now()
      where id = ${sql.placeholder('id')} and ${sql.placeholder('touch')}::boolean
    )
    update interview_devices set last_seq = ${sql.placeholder('seq')}::int, updated_at = now()
    where interview_id = ${sql.placeholder('id')} and device_id = ${sql.placeholder('device')}`,
  {},
);

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
  tx: Tx,
  row: InterviewRow,
) => Promise<Partial<Pick<InterviewRow, 'flags' | 'sampled'>>>;

export type SubmitHook = (
  tx: Tx,
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
    tx: Tx,
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
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    body: StartBody,
    opts: { entryPass?: number | undefined } = {},
  ): Promise<InterviewRow> {
    const settings = await this.cases.settings(tx, projectId);
    const [c] = await tx
      .select()
      .from(cases)
      .where(and(eq(cases.id, body.caseId), eq(cases.projectId, projectId)))
      .for('update');
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
      await this.cases.claim(tx, ctx, projectId, c.id);
      c.assignedTo = ctx.userId;
    }
    const pass = opts.entryPass ?? 1;
    // A second data-entry pass is keyed by another clerk, who does not hold the case.
    if (pass === 1 && c.assignedTo !== ctx.userId) throw new NotFoundException('Case not found');

    const [open] = await tx
      .select()
      .from(interviews)
      .where(and(eq(interviews.caseId, c.id), eq(interviews.status, 'in_progress')));
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
      [row] = (await tx
        .update(interviews)
        .set({ interviewerId: ctx.userId, deviceId: body.deviceId, updatedAt: new Date() })
        .where(eq(interviews.id, open.id))
        .returning()) as [InterviewRow];
    } else {
      const [taken] = await tx.select().from(interviews).where(eq(interviews.id, body.id));
      if (taken) throw new ConflictException({ code: 'ID_IN_USE', message: 'Interview id in use' });
      // A case is interviewed with the questionnaire it belongs to.
      if (c.questionnaireId && c.questionnaireId !== body.questionnaireId)
        throw new ConflictException({
          code: 'OTHER_QUESTIONNAIRE',
          message: 'This case belongs to another questionnaire',
        });
      const version = await this.latestVersion(tx, projectId, body.questionnaireId, body.mode);
      const context = await this.caseContext(tx, ctx, projectId, c, settings.revealToInterviewers);
      [row] = (await tx
        .insert(interviews)
        .values({
          id: body.id,
          tenantId: ctx.tenantId,
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
          details: { interviewId: row.id, mode: body.mode, version: version.version, pass },
        },
      ]);
    }
    await tx
      .insert(interviewDevices)
      .values({ tenantId: ctx.tenantId, interviewId: row.id, deviceId: body.deviceId })
      .onConflictDoNothing();
    return row;
  }

  /**
   * Applies batches of numbered changes. Numbers already acknowledged are skipped and
   * nothing after a gap is taken, so replays are harmless. `authorize` decides per interview
   * (an error code, or null); `create` makes an interview the server has not seen.
   */
  async sync(
    tx: Tx,
    writer: Writer,
    deviceId: string,
    items: SyncItem[],
    authorize: (row: InterviewRow) => string | null,
    create?: (item: SyncItem) => Promise<InterviewRow | string>,
    /** An interview the caller already locked in this transaction (one fewer statement). */
    locked?: InterviewRow,
  ) {
    const acks: Record<string, number> = {};
    const errors: Record<string, string> = {};
    /** The state's new version, for the interviews whose snapshot was written. */
    const versions: Record<string, number> = {};
    // Rows are locked in one global order (by id), so two devices syncing overlapping
    // interviews at once wait for each other instead of deadlocking.
    const ordered = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const item of ordered) {
      let [row] = locked?.id === item.id ? [locked] : await lockInterview.run(tx, { id: item.id });
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
      const [dev] = await touchDevice.run(tx, {
        tenantId: writer.tenantId,
        id: row.id,
        device: deviceId,
      });
      let last = dev!.lastSeq;
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
      if (answers.length)
        await tx
          .insert(interviewAnswerEvents)
          .values(
            answers.map((o) => ({
              tenantId: writer.tenantId,
              interviewId: row.id,
              deviceId,
              seq: o.seq,
              variable: o.variable,
              oldValue: o.oldValue ?? null,
              newValue: o.newValue ?? null,
              at: new Date(o.at),
              byUserId: o.source === 'system' ? null : writer.userId,
              source: o.source,
              reason: o.reason ?? null,
            })),
          )
          .onConflictDoNothing();
      if (para.length)
        await tx
          .insert(interviewParadata)
          .values(
            para.map((o) => ({
              tenantId: writer.tenantId,
              interviewId: row.id,
              deviceId,
              seq: o.seq,
              type: o.type,
              at: new Date(o.at),
              monotonicMs: o.monotonicMs ?? null,
              payload: o.payload,
            })),
          )
          .onConflictDoNothing();
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
      await finishSync.run(tx, {
        id: row.id,
        device: deviceId,
        seq: last,
        touch: fresh && (!!item.state || run.length > 0),
        hasState,
        state: item.state ? JSON.stringify(item.state) : null,
        answers: item.state ? JSON.stringify(item.state.answers ?? {}) : null,
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
    tx: Tx,
    row: InterviewRow,
    body: SubmitBody,
    writer: Writer,
    known: { lastSeq?: number } = {},
  ) {
    if (!EDITABLE.has(row.status))
      throw new ConflictException({ code: 'SUBMITTED', message: 'Already submitted' });
    if (row.deviceId !== body.deviceId)
      throw new ConflictException({
        code: 'NOT_THIS_DEVICE',
        message: 'This interview is open on another device',
      });
    const lastSeq =
      known.lastSeq ?? (await deviceSeq.run(tx, { id: row.id, device: body.deviceId }))[0]?.lastSeq;
    if ((lastSeq ?? 0) < body.seq)
      throw new ConflictException({
        code: 'NOT_SYNCED',
        message: 'Some changes have not reached the server yet',
      });
    const compiled = await this.compiledOf(tx, row.questionnaireVersionId);
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
    for (const c of this.contributors) Object.assign(extra, await c(tx, row));
    const [done] = (await tx
      .update(interviews)
      .set({
        ...extra,
        status: 'submitted',
        disposition,
        endedAt: row.endedAt ?? new Date(),
        submittedAt: new Date(),
        submissions: row.submissions + 1,
        updatedAt: new Date(),
      })
      .where(eq(interviews.id, row.id))
      .returning()) as [InterviewRow];
    if (row.caseId) {
      await this.finaliseCase(tx, writer, row.caseId, disposition, {
        interviewId: row.id,
        disposition,
      });
    }
    for (const hook of this.hooks) await hook(tx, done, disposition, writer);
    if (writer.ctx)
      await this.audit.record(
        tx,
        writer.tenantId,
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
    tx: Tx,
    writer: Writer,
    caseId: string,
    disposition: string,
    details: Record<string, unknown>,
  ) {
    await tx
      .update(cases)
      .set({ status: 'finalised', disposition, updatedAt: new Date() })
      .where(eq(cases.id, caseId));
    await this.cases.events(tx, writer.tenantId, writer.userId, [
      { caseId, type: 'interview_submitted', details },
    ]);
  }

  /**
   * The version in use of a questionnaire, for a new fill; with `mode`, refused unless the
   * questionnaire is fielded in that mode (Q1). A disabled or completed questionnaire takes no
   * new fills, unless `readOnly` (to show what an existing fill uses).
   */
  async latestVersion(
    tx: Tx,
    projectId: string,
    qid: string,
    mode?: Mode,
    opts: { readOnly?: boolean } = {},
  ) {
    // The compiled form comes from the cache (versions never change): reading it here would
    // fetch and decode the whole questionnaire on every start.
    const [found] = await tx
      .select({
        id: questionnaireVersions.id,
        version: questionnaireVersions.version,
        state: questionnaires.state,
      })
      .from(questionnaireVersions)
      .innerJoin(questionnaires, eq(questionnaires.id, questionnaireVersions.questionnaireId))
      .where(
        and(
          eq(questionnaires.id, qid),
          eq(questionnaires.projectId, projectId),
          eq(questionnaireVersions.status, 'published'),
        ),
      )
      .orderBy(desc(questionnaireVersions.version))
      .limit(1);
    const v = found && { ...found, compiled: await this.compiledOf(tx, found.id) };
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
  async questionnairesFor(tx: Tx, projectId: string, mode: Mode) {
    const rows = await tx
      .selectDistinctOn([questionnaires.id], {
        id: questionnaires.id,
        name: questionnaires.name,
        modes: sql<
          string[] | null
        >`${questionnaireVersions.compiled} -> 'questionnaire' -> 'modes'`,
      })
      .from(questionnaires)
      .innerJoin(
        questionnaireVersions,
        eq(questionnaireVersions.questionnaireId, questionnaires.id),
      )
      .where(
        and(
          eq(questionnaires.projectId, projectId),
          eq(questionnaireVersions.status, 'published'),
          // Disabled and completed questionnaires take no new fills.
          eq(questionnaires.state, 'active'),
        ),
      )
      .orderBy(questionnaires.id, desc(questionnaireVersions.version));
    return rows
      .filter((r) => (Array.isArray(r.modes) ? r.modes.includes(mode) : true))
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * A version's compiled questionnaire. Versions never change once written (a trigger refuses
   * updates), so they are kept in memory, the most used first: the respondent page, every sync
   * and every submit need it, and it is the largest thing they read. Ids reach here only from
   * rows the caller's tenant can see (RLS), so the cache never crosses organisations.
   */
  /** Records that the device is on the interview; returns its last acknowledged change. */
  async touchDevice(tx: Tx, tenantId: string, interviewId: string, deviceId: string) {
    const [d] = await touchDevice.run(tx, { tenantId, id: interviewId, device: deviceId });
    return d?.lastSeq ?? 0;
  }

  /** The interview, locked for this transaction (a prepared query). */
  async locked(tx: Tx, id: string): Promise<InterviewRow | undefined> {
    return (await lockInterview.run(tx, { id }))[0];
  }

  /** A version's number and questionnaire (immutable, so cached like the compiled form). */
  async versionOf(tx: Tx, versionId: string) {
    const hit = versionCache.get(versionId);
    if (hit) return hit;
    const [v] = await tx
      .select({
        version: questionnaireVersions.version,
        questionnaireId: questionnaireVersions.questionnaireId,
      })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.id, versionId));
    if (v) versionCache.set(versionId, v);
    return v;
  }

  async compiledOf(tx: Tx, versionId: string) {
    const hit = compiledCache.get(versionId);
    if (hit) return hit;
    const [v] = await tx
      .select({ compiled: questionnaireVersions.compiled })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.id, versionId));
    const compiled = v!.compiled as CompiledQuestionnaire;
    compiledCache.set(versionId, compiled);
    return compiled;
  }

  /** Case data for the engine and the screen, masked as the interviewer would see it. */
  async caseContext(
    tx: Tx,
    ctx: AuthContext | null,
    projectId: string,
    c: typeof cases.$inferSelect,
    reveal: boolean,
  ) {
    const show = !!ctx && reveal && this.cases.canSeePii(ctx, projectId);
    const pii = await this.cases.piiFields(tx, projectId);
    const cs = await tx
      .select({ type: contacts.type, value: contacts.value, label: contacts.label })
      .from(contacts)
      .where(eq(contacts.caseId, c.id))
      .orderBy(asc(contacts.createdAt));
    if (show && ctx)
      await this.cases.recordAutoViews(
        tx,
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

  /** Everything a device needs to show and continue an interview. */
  /**
   * `settings` is the project's, when the caller has already read them (one read of the
   * project per request).
   */
  async payload(
    tx: Tx,
    row: InterviewRow,
    deviceId: string,
    settings?: ProjectSettings,
    lastSeq?: number,
  ) {
    const [dev] =
      lastSeq !== undefined
        ? [{ lastSeq }]
        : await deviceSeq.run(tx, { id: row.id, device: deviceId });
    const v = await this.versionOf(tx, row.questionnaireVersionId);
    const compiled = await this.compiledOf(tx, row.questionnaireVersionId);
    const [who] = row.interviewerId
      ? await tx.select({ name: users.name }).from(users).where(eq(users.id, row.interviewerId))
      : [];
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
        interviewer: who?.name ?? null,
      },
      context: this.contextOf(row),
      compiled,
      settings: await (
        settings ? Promise.resolve(settings) : this.cases.settings(tx, row.projectId)
      ).then((x) => ({ capi: x.capi, shortcuts: x.shortcuts })),
      lastSeq: dev?.lastSeq ?? 0,
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
