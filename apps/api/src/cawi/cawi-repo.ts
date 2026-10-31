import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import { sql as ksql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { ofQuestionnaire } from '../cases/cases.service.js';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { rememberProject, type ProjectRow } from '../cases/project-memo.js';
import { columnsAs, Database, Prepared, type Tx } from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import {
  cases,
  contacts,
  emailTemplates,
  interviewDevices,
  interviews,
  invitations,
  openLinks,
  projectLogos,
  projects,
  questionnaires,
  suppressions,
  waves,
} from '../db/schema.js';
import {
  MssqlInterviewsTx,
  PgInterviewsTx,
  type InterviewRow,
  type InterviewsTx,
} from '../interviews/interviews-repo.js';
import { InterviewsStore } from '../interviews/interviews-store.mssql.js';
import { CawiStore } from './cawi-store.mssql.js';

/**
 * The database side of web surveys and their e-mail, whichever engine runs (the pattern of
 * `auth/auth-repo.ts`). A transaction here is also an `InterviewsTx`: the respondent runs the
 * interview runtime with the link's token instead of a sign-in.
 */
export type InvitationView = typeof invitations.$inferSelect;
export type WaveView = typeof waves.$inferSelect;
export type SuppressionView = typeof suppressions.$inferSelect;
export type OpenLinkView = typeof openLinks.$inferSelect;

export type InvitationPatch = Partial<
  Pick<
    InvitationView,
    | 'status'
    | 'sendAttempts'
    | 'sentAt'
    | 'deliveredAt'
    | 'bouncedAt'
    | 'bounceType'
    | 'openedAt'
    | 'clickedAt'
    | 'startedAt'
    | 'remindersSent'
    | 'lastReminderAt'
    | 'leaseUntil'
    | 'lastError'
    | 'questionnaireId'
  >
>;

export interface NewInvitationRow {
  projectId: string;
  questionnaireId: string;
  waveId: string;
  caseId: string;
  contactId?: string;
  email?: string;
  /** Left out for 'queued'; 'link' for a personal link nothing is sent to. */
  status?: string;
  tokenHash: string;
  tokenEnc: string;
  language: string;
}

export interface WaveCount {
  waveId: string;
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  started: number;
  completed: number;
  bounced: number;
  suppressed: number;
  failed: number;
  reminders: number;
}

export interface TargetView {
  state: string;
  successorId: string | null;
  versionId: string | null;
  version: number | null;
}

export interface CawiTx extends InterviewsTx {
  // Templates
  projectLanguages(projectId: string): Promise<string[] | null>;
  ownTemplates(
    projectId: string,
  ): Promise<{ kind: string; language: string; subject: string; body: string }[]>;
  saveTemplate(
    projectId: string,
    userId: string,
    v: { kind: string; language: string; subject: string; body: string },
  ): Promise<void>;
  template(
    projectId: string,
    kind: string,
    language: string,
  ): Promise<{ subject: string; body: string } | null>;

  // Waves
  hasQuestionnaire(projectId: string, questionnaireId: string): Promise<boolean>;
  insertWave(v: {
    projectId: string;
    questionnaireId: string;
    name: string;
    filter: string | null;
    reminderDays: number[];
    sendAt: Date | null;
    bouncesToCati: boolean;
    channel: string;
    createdBy: string;
  }): Promise<WaveView>;
  waves(projectId: string): Promise<WaveView[]>;
  waveCounts(projectId: string): Promise<WaveCount[]>;
  waveChannel(projectId: string, waveId: string): Promise<string | null>;
  lockWave(projectId: string, waveId: string): Promise<WaveView | null>;
  wave(id: string): Promise<WaveView | null>;
  setWaveStatus(id: string, status: 'sending' | 'sent'): Promise<void>;
  /** Fresh or assigned cases of the questionnaire (or of none), by external id. */
  waveCandidates(
    projectId: string,
    questionnaireId: string,
  ): Promise<
    {
      id: string;
      sample: unknown;
      samplePii: string | null;
      status: string;
      priority: number;
      modePreference: string | null;
    }[]
  >;
  /** Valid e-mail contacts of these cases, oldest first. */
  emailContacts(
    caseIds: string[],
  ): Promise<{ id: string; caseId: string; value: string; consent: unknown }[]>;
  suppressedEmails(): Promise<string[]>;
  /** A case already invited in the wave is skipped. */
  insertInvitations(rows: NewInvitationRow[]): Promise<void>;
  waveLinkRows(
    projectId: string,
    waveId: string,
  ): Promise<
    { tokenEnc: string; externalId: string; startedAt: Date | null; completedAt: Date | null }[]
  >;
  suppressionList(): Promise<SuppressionView[]>;

  // Open link
  openLinkOf(projectId: string): Promise<OpenLinkView | null>;
  updateOpenLink(id: string, patch: { active: boolean; questionnaireId?: string }): Promise<void>;
  insertOpenLink(v: {
    projectId: string;
    questionnaireId: string;
    slug: string;
    active: boolean;
  }): Promise<void>;
  openLinkTarget(
    id: string,
  ): Promise<(TargetView & { projectId: string; questionnaireId: string }) | null>;
  insertOpenInvitation(v: {
    projectId: string;
    questionnaireId: string;
    tokenHash: string;
    tokenEnc: string;
    language: string;
  }): Promise<void>;

  // Dispatch
  /** Queued invitations and due reminders, leased until `leaseUntil` (others skip them). */
  leaseBatch(
    now: Date,
    limit: number,
    leaseUntil: Date,
  ): Promise<{ inv: InvitationView; kind: 'invitation' | 'reminder' }[]>;
  /** Waves whose invitations have all left are sent. */
  markWavesSent(): Promise<void>;
  isSuppressed(email: string): Promise<boolean>;
  caseSample(caseId: string): Promise<{ sample: unknown; samplePii: string | null } | null>;
  patchInvitation(id: string, patch: InvitationPatch): Promise<void>;

  // Tracking, webhook, unsubscribe
  /** The invitation, locked. */
  lockInvitation(id: string): Promise<InvitationView | null>;
  suppress(email: string, reason: string): Promise<void>;
  /** A hard bounce: the case is marked, and optionally moved to telephone interviewing. */
  markBounced(caseId: string, toCati: boolean): Promise<boolean>;

  // Respondents
  /** The link's invitation, locked; the project comes with it where that saves a read. */
  lockLink(id: string): Promise<InvitationView>;
  /** The invitation and its interview, both locked, and the device's last acknowledged change. */
  lockSurvey(
    id: string,
    device: string,
  ): Promise<{ inv: InvitationView; interview: InterviewRow; lastSeq: number | null } | null>;
  caseStatusOf(caseId: string): Promise<string | null>;
  logo(projectId: string): Promise<{ contentType: string; image: Buffer } | null>;
  setInterviewContext(id: string, context: unknown): Promise<void>;
  /** The case's sample for piping, as stored. */
  casePiping(caseId: string): Promise<{ sample: unknown; samplePii: string | null } | null>;
  /** Ties the interview to the invitation and stamps its start. */
  startInvitation(id: string, interviewId: string): Promise<void>;
  completeInvitation(interviewId: string): Promise<void>;
  questionnaireState(id: string): Promise<{ state: string; successorId: string | null } | null>;
  questionnaireTarget(questionnaireId: string, projectId: string): Promise<TargetView | null>;
}

export interface CawiRepo {
  inTenant<T>(tenantId: string, fn: (t: CawiTx) => Promise<T>): Promise<T>;
  /** The organisation of a respondent's token, then the work in it; `found` is null if unknown. */
  ofToken<T>(
    hash: string,
    fn: (t: CawiTx, found: { id: string; tenantId: string } | null) => Promise<T>,
  ): Promise<T>;
  ofOpenLink<T>(
    slug: string,
    fn: (t: CawiTx, found: { id: string; tenantId: string } | null) => Promise<T>,
  ): Promise<T>;
  /** The same transaction, seen as CAWI (for the submit hook). */
  extend(t: InterviewsTx): CawiTx;
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

/** The invitation, locked, with its project. */
const lockLinkQ = new Prepared<{ inv: InvitationView; project: ProjectRow }>(
  () => sql`
    select ${columnsAs(invitations, 'inv', 'inv')}, ${columnsAs(projects, 'p', 'project')}
    from invitations inv join projects p on p.id = inv.project_id
    where inv.id = ${sql.placeholder('id')}
    for update of inv`,
  { inv: getTableColumns(invitations), project: getTableColumns(projects) },
);

/** For syncs and submissions: the invitation and its interview, locked, the project and the device's number. */
const lockSurveyQ = new Prepared<{
  inv: InvitationView;
  interview: InterviewRow;
  project: ProjectRow;
  lastSeq: number | null;
}>(
  () => sql`
    select ${columnsAs(invitations, 'inv', 'inv')}, ${columnsAs(interviews, 'i', 'interview')},
           ${columnsAs(projects, 'p', 'project')}, d.last_seq
    from invitations inv
    join interviews i on i.id = inv.interview_id
    join projects p on p.id = inv.project_id
    left join interview_devices d on d.interview_id = i.id and d.device_id = ${sql.placeholder('device')}
    where inv.id = ${sql.placeholder('id')}
    for update of inv, i`,
  {
    inv: getTableColumns(invitations),
    interview: getTableColumns(interviews),
    project: getTableColumns(projects),
    lastSeq: interviewDevices.lastSeq,
  },
);

/** A questionnaire's state and its latest published version. */
const questionnaireTargetQ = new Prepared<TargetView>(
  () => sql`
    select q.state as "state", q.successor_id as "successorId", v.id as "versionId", v.version as "version"
    from questionnaires q
    left join lateral (
      select id, version from questionnaire_versions
      where questionnaire_id = q.id and status = 'published'
      order by version desc limit 1
    ) v on true
    where q.id = ${sql.placeholder('qid')} and q.project_id = ${sql.placeholder('project')}`,
  { state: 'raw', successorId: 'raw', versionId: 'raw', version: 'raw' },
);

/** An open link with its questionnaire's state and latest published version. */
const openLinkTargetQ = new Prepared<TargetView & { projectId: string; questionnaireId: string }>(
  () => sql`
    select l.project_id as "projectId", l.questionnaire_id as "questionnaireId",
           q.state as "state", q.successor_id as "successorId", v.id as "versionId", v.version as "version"
    from open_links l
    join questionnaires q on q.id = l.questionnaire_id
    left join lateral (
      select id, version from questionnaire_versions
      where questionnaire_id = q.id and status = 'published'
      order by version desc limit 1
    ) v on true
    where l.id = ${sql.placeholder('id')}`,
  {
    projectId: 'raw',
    questionnaireId: 'raw',
    state: 'raw',
    successorId: 'raw',
    versionId: 'raw',
    version: 'raw',
  },
);

const insertOpenInvitationQ = new Prepared<never>(
  (tx) =>
    tx.insert(invitations).values({
      id: sql.placeholder('id'),
      tenantId: sql.placeholder('tenantId'),
      projectId: sql.placeholder('projectId'),
      questionnaireId: sql.placeholder('questionnaireId'),
      tokenHash: sql.placeholder('tokenHash'),
      tokenEnc: sql.placeholder('tokenEnc'),
      language: sql.placeholder('language'),
      status: 'sent',
      sentAt: sql`now()`,
    }),
  {},
);

const startInvitationQ = new Prepared<never>(
  (tx) =>
    tx
      .update(invitations)
      .set({
        interviewId: sql`${sql.placeholder('interview')}`,
        startedAt: sql`coalesce(started_at, now())`,
      })
      .where(eq(invitations.id, sql.placeholder('id'))),
  {},
);

const completeInvitationQ = new Prepared<never>(
  (tx) =>
    tx
      .update(invitations)
      .set({ status: 'completed', completedAt: sql`now()` })
      .where(eq(invitations.interviewId, sql.placeholder('interview'))),
  {},
);

export class PgCawiTx extends PgInterviewsTx implements CawiTx {
  /** The project read together with the link, so the rest of the request does not read it again. */
  private linkProject: ProjectRow | null = null;

  constructor(
    private readonly ctx: Tx,
    private readonly cten: string,
    audits: AuditService,
  ) {
    super(ctx, cten, audits);
  }

  override async project(projectId: string) {
    if (this.linkProject?.id === projectId)
      return this.linkProject as unknown as Awaited<ReturnType<PgInterviewsTx['project']>>;
    return super.project(projectId);
  }

  async projectLanguages(projectId: string) {
    const [p] = await this.ctx
      .select({ languages: projects.languages })
      .from(projects)
      .where(eq(projects.id, projectId));
    return p ? (p.languages ?? []) : null;
  }

  ownTemplates(projectId: string) {
    return this.ctx.select().from(emailTemplates).where(eq(emailTemplates.projectId, projectId));
  }

  async saveTemplate(
    projectId: string,
    userId: string,
    v: { kind: string; language: string; subject: string; body: string },
  ) {
    await this.ctx
      .insert(emailTemplates)
      .values({ tenantId: this.cten, projectId, ...v, updatedBy: userId })
      .onConflictDoUpdate({
        target: [emailTemplates.projectId, emailTemplates.kind, emailTemplates.language],
        set: {
          subject: v.subject,
          body: v.body,
          updatedBy: userId,
          updatedAt: new Date(),
        },
      });
  }

  async template(projectId: string, kind: string, language: string) {
    const [t] = await this.ctx
      .select({ subject: emailTemplates.subject, body: emailTemplates.body })
      .from(emailTemplates)
      .where(
        and(
          eq(emailTemplates.projectId, projectId),
          eq(emailTemplates.kind, kind),
          eq(emailTemplates.language, language),
        ),
      );
    return t ?? null;
  }

  async hasQuestionnaire(projectId: string, questionnaireId: string) {
    const [q] = await this.ctx
      .select({ id: questionnaires.id })
      .from(questionnaires)
      .where(and(eq(questionnaires.id, questionnaireId), eq(questionnaires.projectId, projectId)));
    return !!q;
  }

  async insertWave(v: Parameters<CawiTx['insertWave']>[0]) {
    const [w] = await this.ctx
      .insert(waves)
      .values({ tenantId: this.cten, ...v })
      .returning();
    return w!;
  }

  waves(projectId: string) {
    return this.ctx
      .select()
      .from(waves)
      .where(eq(waves.projectId, projectId))
      .orderBy(desc(waves.createdAt));
  }

  waveCounts(projectId: string) {
    return this.ctx
      .select({
        waveId: invitations.waveId,
        total: sql<number>`count(*)::int`,
        queued: sql<number>`count(*) filter (where ${invitations.status} = 'queued')::int`,
        sent: sql<number>`count(${invitations.sentAt})::int`,
        delivered: sql<number>`count(${invitations.deliveredAt})::int`,
        opened: sql<number>`count(${invitations.openedAt})::int`,
        clicked: sql<number>`count(${invitations.clickedAt})::int`,
        started: sql<number>`count(${invitations.startedAt})::int`,
        completed: sql<number>`count(${invitations.completedAt})::int`,
        bounced: sql<number>`count(*) filter (where ${invitations.bounceType} = 'hard')::int`,
        suppressed: sql<number>`count(*) filter (where ${invitations.status} = 'suppressed')::int`,
        failed: sql<number>`count(*) filter (where ${invitations.status} = 'failed')::int`,
        reminders: sql<number>`coalesce(sum(${invitations.remindersSent}), 0)::int`,
      })
      .from(invitations)
      .where(and(eq(invitations.projectId, projectId), sql`${invitations.waveId} is not null`))
      .groupBy(invitations.waveId) as unknown as Promise<WaveCount[]>;
  }

  async waveChannel(projectId: string, waveId: string) {
    const [peek] = await this.ctx
      .select({ channel: waves.channel })
      .from(waves)
      .where(and(eq(waves.id, waveId), eq(waves.projectId, projectId)));
    return peek?.channel ?? null;
  }

  async lockWave(projectId: string, waveId: string) {
    const [w] = await this.ctx
      .select()
      .from(waves)
      .where(and(eq(waves.id, waveId), eq(waves.projectId, projectId)))
      .for('update');
    return w ?? null;
  }

  async wave(id: string) {
    const [w] = await this.ctx.select().from(waves).where(eq(waves.id, id));
    return w ?? null;
  }

  async setWaveStatus(id: string, status: 'sending' | 'sent') {
    await this.ctx.update(waves).set({ status, sentAt: new Date() }).where(eq(waves.id, id));
  }

  waveCandidates(projectId: string, questionnaireId: string) {
    return this.ctx
      .select({
        id: cases.id,
        sample: cases.sample,
        samplePii: cases.samplePii,
        status: cases.status,
        priority: cases.priority,
        modePreference: cases.modePreference,
      })
      .from(cases)
      .where(
        and(
          eq(cases.projectId, projectId),
          // A campaign invites the cases of its own questionnaire.
          ofQuestionnaire(questionnaireId),
          inArray(cases.status, ['fresh', 'assigned']),
        ),
      )
      .orderBy(asc(cases.externalId));
  }

  async emailContacts(caseIds: string[]) {
    if (!caseIds.length) return [];
    return this.ctx
      .select({
        id: contacts.id,
        caseId: contacts.caseId,
        value: contacts.value,
        consent: contacts.consent,
      })
      .from(contacts)
      .where(
        and(
          inArray(contacts.caseId, caseIds),
          eq(contacts.type, 'email'),
          eq(contacts.valid, true),
        ),
      )
      .orderBy(asc(contacts.createdAt));
  }

  async suppressedEmails() {
    return (await this.ctx.select({ email: suppressions.email }).from(suppressions)).map(
      (s) => s.email,
    );
  }

  async insertInvitations(rows: NewInvitationRow[]) {
    for (let i = 0; i < rows.length; i += 500)
      await this.ctx
        .insert(invitations)
        .values(rows.slice(i, i + 500).map((r) => ({ tenantId: this.cten, ...r })))
        .onConflictDoNothing();
  }

  waveLinkRows(projectId: string, waveId: string) {
    return this.ctx
      .select({
        tokenEnc: invitations.tokenEnc,
        externalId: cases.externalId,
        startedAt: invitations.startedAt,
        completedAt: invitations.completedAt,
      })
      .from(invitations)
      .innerJoin(cases, eq(cases.id, invitations.caseId))
      .where(and(eq(invitations.projectId, projectId), eq(invitations.waveId, waveId)))
      .orderBy(asc(cases.externalId));
  }

  suppressionList() {
    return this.ctx.select().from(suppressions).orderBy(desc(suppressions.createdAt)).limit(1000);
  }

  async openLinkOf(projectId: string) {
    const [l] = await this.ctx.select().from(openLinks).where(eq(openLinks.projectId, projectId));
    return l ?? null;
  }

  async updateOpenLink(id: string, patch: { active: boolean; questionnaireId?: string }) {
    await this.ctx
      .update(openLinks)
      .set({
        active: patch.active,
        ...(patch.questionnaireId ? { questionnaireId: patch.questionnaireId } : {}),
      })
      .where(eq(openLinks.id, id));
  }

  async insertOpenLink(v: Parameters<CawiTx['insertOpenLink']>[0]) {
    await this.ctx.insert(openLinks).values({ tenantId: this.cten, ...v });
  }

  async openLinkTarget(id: string) {
    const [l] = await openLinkTargetQ.run(this.ctx, { id });
    return l ?? null;
  }

  async insertOpenInvitation(v: Parameters<CawiTx['insertOpenInvitation']>[0]) {
    await insertOpenInvitationQ.run(this.ctx, { id: randomUUID(), tenantId: this.cten, ...v });
  }

  async leaseBatch(now: Date, limit: number, leaseUntil: Date) {
    const free = sql`(${invitations.leaseUntil} is null or ${invitations.leaseUntil} < ${now.toISOString()}::timestamptz)`;
    const active = sql`exists (select 1 from questionnaires qq where qq.id = ${invitations.questionnaireId}
                and qq.state = 'active')`;
    const queued = await this.ctx
      .select({ inv: invitations })
      .from(invitations)
      .innerJoin(waves, eq(waves.id, invitations.waveId))
      .where(
        and(
          eq(invitations.status, 'queued'),
          free,
          sql`(${waves.sendAt} is null or ${waves.sendAt} <= ${now.toISOString()}::timestamptz)`,
          // A disabled or completed questionnaire sends nothing; queued mail waits.
          active,
        ),
      )
      .orderBy(asc(invitations.queuedAt))
      .limit(limit)
      .for('update', { of: invitations, skipLocked: true });
    const due = await this.ctx
      .select({ inv: invitations })
      .from(invitations)
      .innerJoin(waves, eq(waves.id, invitations.waveId))
      .where(
        and(
          eq(invitations.status, 'sent'),
          isNull(invitations.completedAt),
          free,
          active,
          // A case finished another way (by telephone, say) or withdrawn is not reminded.
          sql`not exists (select 1 from cases cc where cc.id = ${invitations.caseId}
                and cc.status in ('finalised', 'withdrawn'))`,
          sql`${invitations.remindersSent} < cardinality(${waves.reminderDays})`,
          sql`${invitations.sentAt} + (${waves.reminderDays}[${invitations.remindersSent} + 1] * interval '1 day') <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .limit(limit)
      .for('update', { of: invitations, skipLocked: true });
    const items = [
      ...queued.map((r) => ({ inv: r.inv, kind: 'invitation' as const })),
      ...due.map((r) => ({ inv: r.inv, kind: 'reminder' as const })),
    ];
    if (items.length)
      await this.ctx
        .update(invitations)
        .set({ leaseUntil })
        .where(
          inArray(
            invitations.id,
            items.map((i) => i.inv.id),
          ),
        );
    return items;
  }

  async markWavesSent() {
    await this.ctx.execute(sql`
        update waves set status = 'sent'
        where status = 'sending' and not exists (
          select 1 from invitations i where i.wave_id = waves.id and i.status = 'queued')`);
  }

  async isSuppressed(email: string) {
    const [s] = await this.ctx
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(eq(suppressions.email, email));
    return !!s;
  }

  async caseSample(caseId: string) {
    const [c] = await this.ctx
      .select({ sample: cases.sample, samplePii: cases.samplePii })
      .from(cases)
      .where(eq(cases.id, caseId));
    return c ?? null;
  }

  async patchInvitation(id: string, patch: InvitationPatch) {
    await this.ctx.update(invitations).set(patch).where(eq(invitations.id, id));
  }

  async lockInvitation(id: string) {
    const [inv] = await this.ctx
      .select()
      .from(invitations)
      .where(eq(invitations.id, id))
      .for('update');
    return inv ?? null;
  }

  async suppress(email: string, reason: string) {
    await this.ctx
      .insert(suppressions)
      .values({ tenantId: this.cten, email, reason })
      .onConflictDoNothing();
  }

  async markBounced(caseId: string, toCati: boolean) {
    const [c] = await this.ctx.select().from(cases).where(eq(cases.id, caseId));
    if (!c || c.status === 'finalised' || c.status === 'withdrawn') return false;
    await this.ctx
      .update(cases)
      .set({
        disposition: 'EMAIL_BOUNCED',
        ...(toCati ? { modePreference: 'CATI', nextContactAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(cases.id, caseId));
    return true;
  }

  async lockLink(id: string) {
    const [r] = await lockLinkQ.run(this.ctx, { id });
    this.linkProject = r!.project;
    rememberProject(this.ctx, r!.project);
    return r!.inv;
  }

  async lockSurvey(id: string, device: string) {
    const [r] = await lockSurveyQ.run(this.ctx, { id, device });
    if (!r) return null;
    this.linkProject = r.project;
    rememberProject(this.ctx, r.project);
    return { inv: r.inv, interview: r.interview, lastSeq: r.lastSeq };
  }

  async caseStatusOf(caseId: string) {
    const [c] = await this.ctx
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, caseId));
    return c?.status ?? null;
  }

  async logo(projectId: string) {
    const [logo] = await this.ctx
      .select({ contentType: projectLogos.contentType, image: projectLogos.image })
      .from(projectLogos)
      .where(eq(projectLogos.projectId, projectId));
    return logo ?? null;
  }

  async setInterviewContext(id: string, context: unknown) {
    await this.ctx.update(interviews).set({ context }).where(eq(interviews.id, id));
  }

  async casePiping(caseId: string) {
    const [c] = await this.ctx
      .select({ sample: cases.sample, samplePii: cases.samplePii })
      .from(cases)
      .where(eq(cases.id, caseId));
    return c ?? null;
  }

  async startInvitation(id: string, interviewId: string) {
    await startInvitationQ.run(this.ctx, { id, interview: interviewId });
  }

  async completeInvitation(interviewId: string) {
    await completeInvitationQ.run(this.ctx, { interview: interviewId });
  }

  async questionnaireState(id: string) {
    const [q] = await this.ctx
      .select({ state: questionnaires.state, successorId: questionnaires.successorId })
      .from(questionnaires)
      .where(eq(questionnaires.id, id));
    return q ?? null;
  }

  async questionnaireTarget(questionnaireId: string, projectId: string) {
    const [t] = await questionnaireTargetQ.run(this.ctx, {
      qid: questionnaireId,
      project: projectId,
    });
    return t ?? null;
  }
}

@Injectable()
export class PgCawiRepo implements CawiRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  inTenant<T>(tenantId: string, fn: (t: CawiTx) => Promise<T>) {
    return this.database.withTenant(tenantId, (tx) => fn(new PgCawiTx(tx, tenantId, this.audits)));
  }

  ofToken<T>(
    hash: string,
    fn: (t: CawiTx, found: { id: string; tenantId: string } | null) => Promise<T>,
  ) {
    return this.database.withTenantOf('invitation_by_token', hash, (tx, found) =>
      fn(new PgCawiTx(tx, found?.tenantId ?? '', this.audits), found),
    );
  }

  ofOpenLink<T>(
    slug: string,
    fn: (t: CawiTx, found: { id: string; tenantId: string } | null) => Promise<T>,
  ) {
    return this.database.withTenantOf('open_link_by_slug', slug, (tx, found) =>
      fn(new PgCawiTx(tx, found?.tenantId ?? '', this.audits), found),
    );
  }

  extend(t: InterviewsTx): CawiTx {
    const h = t.handle();
    if (h.kind !== 'pg') throw new Error('Not a PostgreSQL transaction');
    return new PgCawiTx(h.tx, h.tenantId, this.audits);
  }
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const lowOrNull = (s: string | null) => (s === null ? null : s.toLowerCase());
const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));

function toInvitation(r: Record<string, unknown>): InvitationView {
  const g = (k: string) => r[k] as never;
  const id = (k: string) => lowOrNull((r[k] as string | null) ?? null);
  return {
    id: low(r.id as string),
    tenantId: low(r.tenant_id as string),
    projectId: low(r.project_id as string),
    questionnaireId: low(r.questionnaire_id as string),
    waveId: id('wave_id'),
    caseId: id('case_id'),
    contactId: id('contact_id'),
    email: g('email'),
    tokenHash: g('token_hash'),
    tokenEnc: g('token_enc'),
    language: g('language'),
    status: g('status'),
    sendAttempts: g('send_attempts'),
    queuedAt: g('queued_at'),
    sentAt: g('sent_at'),
    deliveredAt: g('delivered_at'),
    bouncedAt: g('bounced_at'),
    bounceType: g('bounce_type'),
    openedAt: g('opened_at'),
    clickedAt: g('clicked_at'),
    startedAt: g('started_at'),
    completedAt: g('completed_at'),
    remindersSent: g('reminders_sent'),
    lastReminderAt: g('last_reminder_at'),
    leaseUntil: g('lease_until'),
    lastError: g('last_error'),
    interviewId: id('interview_id'),
  } as unknown as InvitationView;
}

function toWave(r: Record<string, unknown>): WaveView {
  const g = (k: string) => r[k] as never;
  return {
    id: low(r.id as string),
    tenantId: low(r.tenant_id as string),
    projectId: low(r.project_id as string),
    questionnaireId: low(r.questionnaire_id as string),
    name: g('name'),
    status: g('status'),
    channel: g('channel'),
    filter: g('filter'),
    reminderDays: parse<number[]>(r.reminder_days as string),
    sendAt: g('send_at'),
    bouncesToCati: !!r.bounces_to_cati,
    createdBy: lowOrNull((r.created_by as string | null) ?? null),
    createdAt: g('created_at'),
    sentAt: g('sent_at'),
  } as unknown as WaveView;
}

const toOpenLink = (r: Record<string, unknown>): OpenLinkView =>
  ({
    id: low(r.id as string),
    tenantId: low(r.tenant_id as string),
    projectId: low(r.project_id as string),
    questionnaireId: low(r.questionnaire_id as string),
    slug: r.slug,
    active: !!r.active,
    createdAt: r.created_at,
  }) as unknown as OpenLinkView;

const INVITATION_COLUMNS: Record<keyof InvitationPatch, string> = {
  status: 'status',
  sendAttempts: 'send_attempts',
  sentAt: 'sent_at',
  deliveredAt: 'delivered_at',
  bouncedAt: 'bounced_at',
  bounceType: 'bounce_type',
  openedAt: 'opened_at',
  clickedAt: 'clicked_at',
  startedAt: 'started_at',
  remindersSent: 'reminders_sent',
  lastReminderAt: 'last_reminder_at',
  leaseUntil: 'lease_until',
  lastError: 'last_error',
  questionnaireId: 'questionnaire_id',
};

export class MssqlCawiTx extends MssqlInterviewsTx implements CawiTx {
  constructor(
    private readonly mctx: MssqlTx,
    private readonly mten: string,
    cstore: CasesStore,
    istore: InterviewsStore,
    private readonly cawi: CawiStore,
  ) {
    super(mctx, mten, cstore, istore);
  }

  async projectLanguages(projectId: string) {
    const p = await this.mctx
      .selectFrom('projects')
      .select('languages')
      .where('id', '=', projectId)
      .executeTakeFirst();
    return p ? (parse<string[]>(p.languages) ?? []) : null;
  }

  async ownTemplates(projectId: string) {
    const rows = await this.cawi.templates(this.mctx, projectId);
    return rows.map((r) => ({
      kind: r.kind,
      language: r.language,
      subject: r.subject,
      body: r.body,
    }));
  }

  saveTemplate(
    projectId: string,
    userId: string,
    v: { kind: string; language: string; subject: string; body: string },
  ) {
    return this.cawi.saveTemplate(this.mctx, { tenantId: this.mten, projectId, userId, ...v });
  }

  async template(projectId: string, kind: string, language: string) {
    const t = await this.mctx
      .selectFrom('email_templates')
      .select(['subject', 'body'])
      .where('project_id', '=', projectId)
      .where('kind', '=', kind)
      .where('language', '=', language)
      .executeTakeFirst();
    return t ?? null;
  }

  async hasQuestionnaire(projectId: string, questionnaireId: string) {
    const q = await this.mctx
      .selectFrom('questionnaires')
      .select('id')
      .where('id', '=', questionnaireId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return !!q;
  }

  async insertWave(v: Parameters<CawiTx['insertWave']>[0]) {
    const id = await this.cawi.createWave(this.mctx, {
      tenantId: this.mten,
      projectId: v.projectId,
      questionnaireId: v.questionnaireId,
      name: v.name,
      channel: v.channel as 'email' | 'links',
      filter: v.filter,
      reminderDays: v.reminderDays,
      sendAt: v.sendAt,
      bouncesToCati: v.bouncesToCati,
      createdBy: v.createdBy,
    });
    return (await this.wave(id))!;
  }

  async waves(projectId: string) {
    const rows = await this.mctx
      .selectFrom('waves')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => toWave(r as never));
  }

  async waveCounts(projectId: string) {
    const res = await ksql<Record<string, number | string>>`
      SELECT wave_id,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        COUNT(sent_at) AS sent, COUNT(delivered_at) AS delivered, COUNT(opened_at) AS opened,
        COUNT(clicked_at) AS clicked, COUNT(started_at) AS started, COUNT(completed_at) AS completed,
        SUM(CASE WHEN bounce_type = 'hard' THEN 1 ELSE 0 END) AS bounced,
        SUM(CASE WHEN status = 'suppressed' THEN 1 ELSE 0 END) AS suppressed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        COALESCE(SUM(reminders_sent), 0) AS reminders
      FROM dbo.invitations
      WHERE project_id = ${projectId} AND wave_id IS NOT NULL
      GROUP BY wave_id`.execute(this.mctx);
    return res.rows.map((r) => ({
      waveId: low(r.wave_id as string),
      total: Number(r.total),
      queued: Number(r.queued),
      sent: Number(r.sent),
      delivered: Number(r.delivered),
      opened: Number(r.opened),
      clicked: Number(r.clicked),
      started: Number(r.started),
      completed: Number(r.completed),
      bounced: Number(r.bounced),
      suppressed: Number(r.suppressed),
      failed: Number(r.failed),
      reminders: Number(r.reminders),
    }));
  }

  async waveChannel(projectId: string, waveId: string) {
    const w = await this.mctx
      .selectFrom('waves')
      .select('channel')
      .where('id', '=', waveId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return w?.channel ?? null;
  }

  async lockWave(projectId: string, waveId: string) {
    const w = await this.cawi.lockWave(this.mctx, waveId);
    if (!w || low(w.project_id) !== projectId) return null;
    return toWave({ ...w, reminder_days: JSON.stringify(w.reminder_days) });
  }

  async wave(id: string) {
    const w = await this.mctx
      .selectFrom('waves')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return w ? toWave(w as never) : null;
  }

  async setWaveStatus(id: string, status: 'sending' | 'sent') {
    await this.mctx
      .updateTable('waves')
      .set({ status, sent_at: ksql<Date>`SYSDATETIMEOFFSET()` })
      .where('id', '=', id)
      .execute();
  }

  async waveCandidates(projectId: string, questionnaireId: string) {
    const res = await ksql<Record<string, unknown>>`
      SELECT id, sample, sample_pii, status, priority, mode_preference FROM dbo.cases
      WHERE project_id = ${projectId}
        AND (questionnaire_id IS NULL OR questionnaire_id = ${questionnaireId})
        AND status IN ('fresh', 'assigned')
      ORDER BY external_id`.execute(this.mctx);
    return res.rows.map((r) => ({
      id: low(r.id as string),
      sample: parse(r.sample as string),
      samplePii: (r.sample_pii as string | null) ?? null,
      status: r.status as string,
      priority: r.priority as number,
      modePreference: (r.mode_preference as string | null) ?? null,
    }));
  }

  async emailContacts(caseIds: string[]) {
    // A case's contacts are all in one chunk, oldest first.
    const out: { id: string; caseId: string; value: string; consent: unknown }[] = [];
    for (let i = 0; i < caseIds.length; i += 1000) {
      const rows = await this.mctx
        .selectFrom('contacts')
        .select(['id', 'case_id', 'value', 'consent'])
        .where('case_id', 'in', caseIds.slice(i, i + 1000))
        .where('type', '=', 'email')
        .where('valid', '=', true)
        .orderBy('created_at')
        .execute();
      for (const r of rows)
        out.push({
          id: low(r.id),
          caseId: low(r.case_id),
          value: r.value,
          consent: parse(r.consent),
        });
    }
    return out;
  }

  async suppressedEmails() {
    const rows = await this.mctx.selectFrom('suppressions').select('email').execute();
    return rows.map((r) => r.email);
  }

  async insertInvitations(rows: NewInvitationRow[]) {
    // Rows of one wave share its questionnaire and project.
    const first = rows[0];
    if (!first) return;
    await this.cawi.addInvitations(this.mctx, {
      tenantId: this.mten,
      projectId: first.projectId,
      questionnaireId: first.questionnaireId,
      waveId: first.waveId,
      rows: rows.map((r) => ({
        caseId: r.caseId,
        contactId: r.contactId ?? null,
        email: r.email ?? null,
        tokenHash: r.tokenHash,
        tokenEnc: r.tokenEnc,
        language: r.language,
        status: (r.status ?? 'queued') as 'queued' | 'sent',
      })),
    });
  }

  async waveLinkRows(projectId: string, waveId: string) {
    const res = await ksql<Record<string, unknown>>`
      SELECT i.token_enc, c.external_id, i.started_at, i.completed_at
      FROM dbo.invitations i JOIN dbo.cases c ON c.id = i.case_id
      WHERE i.project_id = ${projectId} AND i.wave_id = ${waveId}
      ORDER BY c.external_id`.execute(this.mctx);
    return res.rows.map((r) => ({
      tokenEnc: r.token_enc as string,
      externalId: r.external_id as string,
      startedAt: (r.started_at as Date | null) ?? null,
      completedAt: (r.completed_at as Date | null) ?? null,
    }));
  }

  async suppressionList() {
    const rows = await this.mctx
      .selectFrom('suppressions')
      .selectAll()
      .orderBy('created_at', 'desc')
      .top(1000)
      .execute();
    return rows.map(
      (r) =>
        ({
          id: low(r.id),
          tenantId: low(r.tenant_id),
          email: r.email,
          reason: r.reason,
          createdAt: r.created_at,
        }) as unknown as SuppressionView,
    );
  }

  async openLinkOf(projectId: string) {
    const l = await this.mctx
      .selectFrom('open_links')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return l ? toOpenLink(l as never) : null;
  }

  async updateOpenLink(id: string, patch: { active: boolean; questionnaireId?: string }) {
    await this.mctx
      .updateTable('open_links')
      .set({
        active: patch.active,
        ...(patch.questionnaireId ? { questionnaire_id: patch.questionnaireId } : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  async insertOpenLink(v: Parameters<CawiTx['insertOpenLink']>[0]) {
    const id = await this.cawi.createOpenLink(this.mctx, {
      tenantId: this.mten,
      projectId: v.projectId,
      questionnaireId: v.questionnaireId,
      slug: v.slug,
    });
    if (!v.active) await this.cawi.setOpenLinkActive(this.mctx, id, false);
  }

  async openLinkTarget(id: string) {
    const res = await ksql<Record<string, unknown>>`
      SELECT l.project_id, l.questionnaire_id, q.state, q.successor_id, v.id AS version_id, v.version
      FROM dbo.open_links l
      JOIN dbo.questionnaires q ON q.id = l.questionnaire_id
      OUTER APPLY (
        SELECT TOP 1 id, version FROM dbo.questionnaire_versions
        WHERE questionnaire_id = q.id AND status = 'published' ORDER BY version DESC
      ) v
      WHERE l.id = ${id}`.execute(this.mctx);
    const r = res.rows[0];
    return r
      ? {
          projectId: low(r.project_id as string),
          questionnaireId: low(r.questionnaire_id as string),
          state: r.state as string,
          successorId: lowOrNull((r.successor_id as string | null) ?? null),
          versionId: lowOrNull((r.version_id as string | null) ?? null),
          version: (r.version as number | null) ?? null,
        }
      : null;
  }

  async insertOpenInvitation(v: Parameters<CawiTx['insertOpenInvitation']>[0]) {
    await ksql`
      INSERT INTO dbo.invitations (id, tenant_id, project_id, questionnaire_id, token_hash,
        token_enc, language, status, sent_at)
      VALUES (${randomUUID()}, ${this.mten}, ${v.projectId}, ${v.questionnaireId}, ${v.tokenHash},
        ${v.tokenEnc}, ${v.language}, 'sent', SYSDATETIMEOFFSET())`.execute(this.mctx);
  }

  async leaseBatch(now: Date, limit: number, leaseUntil: Date) {
    const taken = await this.cawi.lease(this.mctx, {
      now,
      limit,
      leaseMs: leaseUntil.getTime() - now.getTime(),
    });
    return taken.map((t) => ({
      inv: toInvitation(t.invitation as never),
      kind: t.kind,
    }));
  }

  async markWavesSent() {
    await ksql`
      UPDATE dbo.waves SET status = 'sent'
      WHERE status = 'sending' AND NOT EXISTS (
        SELECT 1 FROM dbo.invitations i WHERE i.wave_id = waves.id AND i.status = 'queued')`.execute(
      this.mctx,
    );
  }

  async isSuppressed(email: string) {
    const s = await this.mctx
      .selectFrom('suppressions')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();
    return !!s;
  }

  async caseSample(caseId: string) {
    return this.casePiping(caseId);
  }

  async patchInvitation(id: string, patch: InvitationPatch) {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      set[INVITATION_COLUMNS[k as keyof InvitationPatch]] = v instanceof Date ? instant(v) : v;
    }
    if (!Object.keys(set).length) return;
    await this.mctx
      .updateTable('invitations')
      .set(set as never)
      .where('id', '=', id)
      .execute();
  }

  async lockInvitation(id: string) {
    const res = await ksql<Record<string, unknown>>`
      SELECT * FROM dbo.invitations WITH (UPDLOCK, ROWLOCK) WHERE id = ${id}`.execute(this.mctx);
    return res.rows[0] ? toInvitation(res.rows[0]) : null;
  }

  suppress(email: string, reason: string) {
    return this.cawi.suppress(this.mctx, {
      tenantId: this.mten,
      email,
      reason: reason as 'hard_bounce' | 'complaint' | 'unsubscribe',
    });
  }

  async markBounced(caseId: string, toCati: boolean) {
    const c = await this.mctx
      .selectFrom('cases')
      .select('status')
      .where('id', '=', caseId)
      .executeTakeFirst();
    if (!c || c.status === 'finalised' || c.status === 'withdrawn') return false;
    await this.mctx
      .updateTable('cases')
      .set({
        disposition: 'EMAIL_BOUNCED',
        ...(toCati
          ? { mode_preference: 'CATI', next_contact_at: ksql<Date>`SYSDATETIMEOFFSET()` }
          : {}),
        updated_at: ksql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', caseId)
      .execute();
    return true;
  }

  async lockLink(id: string) {
    return (await this.lockInvitation(id))!;
  }

  async lockSurvey(id: string, device: string) {
    const inv = await this.lockInvitation(id);
    if (!inv?.interviewId) return null;
    const interview = await this.interview(inv.interviewId, true);
    if (!interview) return null;
    const lastSeq = (await this.deviceSeq(interview.id, device)) ?? null;
    return { inv, interview, lastSeq };
  }

  async caseStatusOf(caseId: string) {
    const c = await this.mctx
      .selectFrom('cases')
      .select('status')
      .where('id', '=', caseId)
      .executeTakeFirst();
    return c?.status ?? null;
  }

  async logo(projectId: string) {
    const l = await this.mctx
      .selectFrom('project_logos')
      .select(['content_type', 'image'])
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return l ? { contentType: l.content_type, image: l.image } : null;
  }

  async setInterviewContext(id: string, context: unknown) {
    await this.mctx
      .updateTable('interviews')
      .set({ context: JSON.stringify(context) })
      .where('id', '=', id)
      .execute();
  }

  async casePiping(caseId: string) {
    const c = await this.mctx
      .selectFrom('cases')
      .select(['sample', 'sample_pii'])
      .where('id', '=', caseId)
      .executeTakeFirst();
    return c ? { sample: parse(c.sample), samplePii: c.sample_pii } : null;
  }

  async startInvitation(id: string, interviewId: string) {
    await this.mctx
      .updateTable('invitations')
      .set({
        interview_id: interviewId,
        started_at: ksql<Date>`COALESCE(started_at, SYSDATETIMEOFFSET())`,
      })
      .where('id', '=', id)
      .execute();
  }

  async completeInvitation(interviewId: string) {
    await this.mctx
      .updateTable('invitations')
      .set({ status: 'completed', completed_at: ksql<Date>`SYSDATETIMEOFFSET()` })
      .where('interview_id', '=', interviewId)
      .execute();
  }

  async questionnaireState(id: string) {
    const q = await this.mctx
      .selectFrom('questionnaires')
      .select(['state', 'successor_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    return q ? { state: q.state, successorId: lowOrNull(q.successor_id) } : null;
  }

  async questionnaireTarget(questionnaireId: string, projectId: string) {
    const res = await ksql<Record<string, unknown>>`
      SELECT q.state, q.successor_id, v.id AS version_id, v.version
      FROM dbo.questionnaires q
      OUTER APPLY (
        SELECT TOP 1 id, version FROM dbo.questionnaire_versions
        WHERE questionnaire_id = q.id AND status = 'published' ORDER BY version DESC
      ) v
      WHERE q.id = ${questionnaireId} AND q.project_id = ${projectId}`.execute(this.mctx);
    const r = res.rows[0];
    return r
      ? {
          state: r.state as string,
          successorId: lowOrNull((r.successor_id as string | null) ?? null),
          versionId: lowOrNull((r.version_id as string | null) ?? null),
          version: (r.version as number | null) ?? null,
        }
      : null;
  }
}

@Injectable()
export class MssqlCawiRepo implements CawiRepo {
  private readonly cstore = new CasesStore();
  private readonly istore = new InterviewsStore();
  private readonly cawi = new CawiStore();

  constructor(private readonly engine: Engine) {}

  private view(tx: MssqlTx, tenantId: string) {
    return new MssqlCawiTx(tx, tenantId, this.cstore, this.istore, this.cawi);
  }

  inTenant<T>(tenantId: string, fn: (t: CawiTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) => fn(this.view(tx, tenantId)));
  }

  ofToken<T>(
    hash: string,
    fn: (t: CawiTx, found: { id: string; tenantId: string } | null) => Promise<T>,
  ) {
    return this.engine.sql.withTenantOf('invitation_by_token', hash, (tx, found) =>
      fn(this.view(tx, found?.tenantId ?? ''), found),
    );
  }

  ofOpenLink<T>(
    slug: string,
    fn: (t: CawiTx, found: { id: string; tenantId: string } | null) => Promise<T>,
  ) {
    return this.engine.sql.withTenantOf('open_link_by_slug', slug, (tx, found) =>
      fn(this.view(tx, found?.tenantId ?? ''), found),
    );
  }

  extend(t: InterviewsTx): CawiTx {
    const h = t.handle();
    if (h.kind !== 'mssql') throw new Error('Not a SQL Server transaction');
    return this.view(h.tx, h.tenantId);
  }
}

export const CAWI_REPO = Symbol('CAWI_REPO');
