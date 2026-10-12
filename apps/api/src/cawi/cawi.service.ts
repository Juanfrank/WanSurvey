import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { compileRule, ruleError } from '../cases/case-logic.js';
import { CasesService } from '../cases/cases.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { decryptField, encryptField, randomToken, sha256Hex } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Database, type Tx } from '../db/database.js';
import {
  cases,
  contacts,
  emailTemplates,
  interviewDevices,
  interviews,
  invitations,
  openLinks,
  projects,
  questionnaires,
  suppressions,
  waves,
} from '../db/schema.js';
import { InterviewsService, type InterviewRow } from '../interviews/interviews.service.js';
import { DeviceId, SubmitBody, SyncItem } from '../interviews/schemas.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import {
  TEMPLATE_KINDS,
  defaultTemplate,
  renderTemplate,
  templateProblems,
  type TemplateKind,
} from './templates.js';

export const TemplateBody = z.strictObject({
  kind: z.enum(TEMPLATE_KINDS),
  language: z.string().min(2).max(16),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
});

export const WaveBody = z.strictObject({
  name: z.string().min(1).max(200),
  questionnaireId: z.uuid(),
  filter: z.string().max(2000).optional(),
  reminderDays: z.array(z.number().int().min(1).max(90)).max(5).default([]),
  sendAt: z.iso.datetime({ offset: true }).optional(),
  bouncesToCati: z.boolean().default(false),
});

export const OpenLinkBody = z.strictObject({
  active: z.boolean(),
  questionnaireId: z.uuid().optional(),
});

export const WebhookBody = z.object({
  events: z
    .array(
      z.object({
        invitationId: z.uuid(),
        type: z.enum(['delivered', 'bounce', 'complaint']),
        bounceType: z.enum(['hard', 'soft']).optional(),
        reason: z.string().max(500).optional(),
      }),
    )
    .max(500),
});

export const RespondentSync = SyncItem.omit({ id: true, start: true }).extend({
  deviceId: DeviceId,
});

const MAX_SEND_ATTEMPTS = 5;
/** E-mails per organisation and run of the dispatcher. */
export const DISPATCH_BATCH = 200;

type InvitationRow = typeof invitations.$inferSelect;

const lower = (e: string) => e.trim().toLowerCase();

/**
 * Web surveys by e-mail (spec §6.4, §8; decisions W1–W7): templates, waves of invitations
 * with reminders, delivery tracking, bounces and unsubscribes, and the respondent's side of
 * the interview runtime, reached with a link token instead of a sign-in.
 */
@Injectable()
export class CawiService implements OnModuleInit {
  constructor(
    private readonly database: Database,
    private readonly cases: CasesService,
    private readonly runtime: InterviewsService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  onModuleInit() {
    // A finished web interview completes its invitation.
    this.runtime.onSubmitted(async (tx, row) => {
      if (row.mode !== 'CAWI') return;
      await tx
        .update(invitations)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(invitations.interviewId, row.id));
    });
  }

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  private get webBase() {
    return this.config.PUBLIC_SURVEY_URL ?? this.config.PUBLIC_WEB_URL;
  }
  surveyUrl(token: string) {
    return `${this.webBase}/s/${token}`;
  }
  private clickUrl(token: string) {
    return `${this.config.PUBLIC_WEB_URL}/api/v1/t/c/${token}`;
  }
  private pixelUrl(token: string) {
    return `${this.config.PUBLIC_WEB_URL}/api/v1/t/o/${token}.gif`;
  }
  private unsubscribeUrl(token: string) {
    return `${this.webBase}/u/${token}`;
  }

  /** A new link token: the raw value goes in the link only (W1). */
  private newToken() {
    const token = randomToken(24);
    return {
      token,
      tokenHash: sha256Hex(token),
      tokenEnc: encryptField(token, this.config.APP_ENCRYPTION_KEY),
    };
  }

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  private async languages(tx: Tx, projectId: string) {
    const [p] = await tx
      .select({ languages: projects.languages })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!p) throw new NotFoundException('Project not found');
    return [...new Set(['es', ...(p.languages ?? [])])];
  }

  /** Every kind × project language, the project's own wording or the default. */
  async templates(tx: Tx, projectId: string) {
    const own = await tx
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.projectId, projectId));
    const out = [];
    for (const language of await this.languages(tx, projectId))
      for (const kind of TEMPLATE_KINDS) {
        const t = own.find((x) => x.kind === kind && x.language === language);
        const d = defaultTemplate(kind, language);
        out.push({
          kind,
          language,
          subject: t?.subject ?? d.subject,
          body: t?.body ?? d.body,
          custom: !!t,
        });
      }
    return out;
  }

  async saveTemplate(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    body: z.infer<typeof TemplateBody>,
  ) {
    const problems = templateProblems(body);
    if (problems.length)
      throw new BadRequestException({
        code: 'TEMPLATE_INVALID',
        message: `Unknown or missing placeholders: ${problems.join(', ')}`,
        problems,
      });
    await tx
      .insert(emailTemplates)
      .values({ tenantId: ctx.tenantId, projectId, ...body, updatedBy: ctx.userId })
      .onConflictDoUpdate({
        target: [emailTemplates.projectId, emailTemplates.kind, emailTemplates.language],
        set: {
          subject: body.subject,
          body: body.body,
          updatedBy: ctx.userId,
          updatedAt: new Date(),
        },
      });
    return this.templates(tx, projectId);
  }

  private async templateFor(tx: Tx, projectId: string, kind: TemplateKind, language: string) {
    const [t] = await tx
      .select({ subject: emailTemplates.subject, body: emailTemplates.body })
      .from(emailTemplates)
      .where(
        and(
          eq(emailTemplates.projectId, projectId),
          eq(emailTemplates.kind, kind),
          eq(emailTemplates.language, language),
        ),
      );
    return t ?? defaultTemplate(kind, language);
  }

  // -------------------------------------------------------------------------
  // Waves
  // -------------------------------------------------------------------------

  async createWave(tx: Tx, ctx: AuthContext, projectId: string, body: z.infer<typeof WaveBody>) {
    if (body.filter) {
      const err = ruleError(body.filter);
      if (err) throw new BadRequestException({ code: 'BAD_FILTER', message: err });
    }
    const [q] = await tx
      .select({ id: questionnaires.id })
      .from(questionnaires)
      .where(
        and(eq(questionnaires.id, body.questionnaireId), eq(questionnaires.projectId, projectId)),
      );
    if (!q) throw new BadRequestException({ code: 'NOT_FOUND', message: 'Unknown questionnaire' });
    await this.runtime.latestVersion(tx, projectId, body.questionnaireId);
    const [w] = await tx
      .insert(waves)
      .values({
        tenantId: ctx.tenantId,
        projectId,
        questionnaireId: body.questionnaireId,
        name: body.name,
        filter: body.filter?.trim() || null,
        reminderDays: [...body.reminderDays].sort((a, b) => a - b),
        sendAt: body.sendAt ? new Date(body.sendAt) : null,
        bouncesToCati: body.bouncesToCati,
        createdBy: ctx.userId,
      })
      .returning();
    return w!;
  }

  /** Waves with their funnel: sent → delivered → opened → clicked → started → completed. */
  async listWaves(tx: Tx, projectId: string) {
    const ws = await tx
      .select()
      .from(waves)
      .where(eq(waves.projectId, projectId))
      .orderBy(desc(waves.createdAt));
    const counts = await tx
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
      .groupBy(invitations.waveId);
    return ws.map((w) => {
      const c = counts.find((x) => x.waveId === w.id);
      return {
        ...w,
        funnel: {
          total: c?.total ?? 0,
          queued: c?.queued ?? 0,
          sent: c?.sent ?? 0,
          delivered: c?.delivered ?? 0,
          opened: c?.opened ?? 0,
          clicked: c?.clicked ?? 0,
          started: c?.started ?? 0,
          completed: c?.completed ?? 0,
          bounced: c?.bounced ?? 0,
          suppressed: c?.suppressed ?? 0,
          failed: c?.failed ?? 0,
          reminders: c?.reminders ?? 0,
        },
      };
    });
  }

  /**
   * Queues an invitation for every eligible case of the wave: matching its rule, not
   * finished, with a usable e-mail address that is not suppressed, and only once the project
   * has declared its lawful basis for e-mailing (W4). The dispatcher sends them.
   */
  async sendWave(tx: Tx, ctx: AuthContext, projectId: string, waveId: string) {
    const settings = await this.cases.settings(tx, projectId);
    if (!settings.cawi.lawfulBasis)
      throw new BadRequestException({
        code: 'NO_LAWFUL_BASIS',
        message: 'Declare the lawful basis for e-mailing this sample first',
      });
    const [w] = await tx
      .select()
      .from(waves)
      .where(and(eq(waves.id, waveId), eq(waves.projectId, projectId)))
      .for('update');
    if (!w) throw new NotFoundException('Wave not found');
    if (w.status !== 'draft')
      throw new ConflictException({ code: 'WAVE_SENT', message: 'This wave has been sent' });
    const v = await this.runtime.latestVersion(tx, projectId, w.questionnaireId);
    const compiled = v.compiled as CompiledQuestionnaire;
    const match = compileRule(w.filter);
    const candidates = (
      await tx
        .select({
          id: cases.id,
          sample: cases.sample,
          status: cases.status,
          priority: cases.priority,
          modePreference: cases.modePreference,
        })
        .from(cases)
        .where(and(eq(cases.projectId, projectId), inArray(cases.status, ['fresh', 'assigned'])))
        .orderBy(asc(cases.externalId))
    ).filter(match);
    const emails = candidates.length
      ? await tx
          .select({
            id: contacts.id,
            caseId: contacts.caseId,
            value: contacts.value,
            consent: contacts.consent,
          })
          .from(contacts)
          .where(
            and(
              inArray(
                contacts.caseId,
                candidates.map((c) => c.id),
              ),
              eq(contacts.type, 'email'),
              eq(contacts.valid, true),
            ),
          )
          .orderBy(asc(contacts.createdAt))
      : [];
    const suppressed = new Set(
      (await tx.select({ email: suppressions.email }).from(suppressions)).map((s) => s.email),
    );
    const skipped = { noEmail: 0, suppressed: 0, optedOut: 0 };
    const rows: (typeof invitations.$inferInsert)[] = [];
    for (const c of candidates) {
      const all = emails.filter((e) => e.caseId === c.id);
      const usable = all.filter((e) => (e.consent as { email?: boolean }).email !== false);
      const e = usable.find((x) => !suppressed.has(lower(x.value)));
      if (!all.length) skipped.noEmail++;
      else if (!usable.length) skipped.optedOut++;
      else if (!e) skipped.suppressed++;
      if (!e) continue;
      const sample = c.sample as Record<string, unknown>;
      const language =
        typeof sample.language === 'string' &&
        compiled.questionnaire.languages.includes(sample.language)
          ? sample.language
          : compiled.questionnaire.defaultLanguage;
      const { tokenHash, tokenEnc } = this.newToken();
      rows.push({
        tenantId: ctx.tenantId,
        projectId,
        questionnaireId: w.questionnaireId,
        waveId: w.id,
        caseId: c.id,
        contactId: e.id,
        email: lower(e.value),
        tokenHash,
        tokenEnc,
        language,
      });
    }
    for (let i = 0; i < rows.length; i += 500)
      await tx
        .insert(invitations)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing();
    await tx.update(waves).set({ status: 'sending', sentAt: new Date() }).where(eq(waves.id, w.id));
    await this.cases.events(
      tx,
      ctx.tenantId,
      ctx.userId,
      rows.map((r) => ({ caseId: r.caseId!, type: 'invited', details: { waveId: w.id } })),
    );
    return { queued: rows.length, skipped };
  }

  async suppressionList(tx: Tx) {
    return tx.select().from(suppressions).orderBy(desc(suppressions.createdAt)).limit(1000);
  }

  // -------------------------------------------------------------------------
  // Open link (W6)
  // -------------------------------------------------------------------------

  async openLink(tx: Tx, projectId: string) {
    const [l] = await tx.select().from(openLinks).where(eq(openLinks.projectId, projectId));
    return l ? { ...l, url: `${this.webBase}/o/${l.slug}` } : null;
  }

  async setOpenLink(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    body: z.infer<typeof OpenLinkBody>,
  ) {
    const current = await this.openLink(tx, projectId);
    if (current) {
      await tx
        .update(openLinks)
        .set({
          active: body.active,
          ...(body.questionnaireId ? { questionnaireId: body.questionnaireId } : {}),
        })
        .where(eq(openLinks.id, current.id));
    } else {
      if (!body.questionnaireId)
        throw new BadRequestException({ code: 'NOT_FOUND', message: 'Choose a questionnaire' });
      await this.runtime.latestVersion(tx, projectId, body.questionnaireId);
      await tx.insert(openLinks).values({
        tenantId: ctx.tenantId,
        projectId,
        questionnaireId: body.questionnaireId,
        slug: randomToken(9),
        active: body.active,
      });
    }
    return this.openLink(tx, projectId);
  }

  // -------------------------------------------------------------------------
  // Dispatch (called by the dispatcher, per organisation)
  // -------------------------------------------------------------------------

  /** Sends queued invitations and due reminders of one organisation. Returns how many went out. */
  async dispatch(tx: Tx, tenantId: string, now = new Date(), limit = DISPATCH_BATCH) {
    let sent = 0;
    const queued = await tx
      .select({ inv: invitations, wave: waves })
      .from(invitations)
      .innerJoin(waves, eq(waves.id, invitations.waveId))
      .where(
        and(
          eq(invitations.status, 'queued'),
          sql`(${waves.sendAt} is null or ${waves.sendAt} <= ${now.toISOString()}::timestamptz)`,
        ),
      )
      .orderBy(asc(invitations.queuedAt))
      .limit(limit)
      .for('update', { of: invitations, skipLocked: true });
    for (const { inv } of queued)
      if (await this.sendOne(tx, tenantId, inv, 'invitation', now)) sent++;

    const due = await tx
      .select({ inv: invitations, wave: waves })
      .from(invitations)
      .innerJoin(waves, eq(waves.id, invitations.waveId))
      .where(
        and(
          eq(invitations.status, 'sent'),
          isNull(invitations.completedAt),
          sql`${invitations.remindersSent} < cardinality(${waves.reminderDays})`,
          sql`${invitations.sentAt} + (${waves.reminderDays}[${invitations.remindersSent} + 1] * interval '1 day') <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .limit(limit)
      .for('update', { of: invitations, skipLocked: true });
    for (const { inv } of due) if (await this.sendOne(tx, tenantId, inv, 'reminder', now)) sent++;

    // Waves whose invitations have all left are sent.
    await tx.execute(sql`
      update waves set status = 'sent'
      where status = 'sending' and not exists (
        select 1 from invitations i where i.wave_id = waves.id and i.status = 'queued')`);
    return sent;
  }

  private async sendOne(
    tx: Tx,
    tenantId: string,
    inv: InvitationRow,
    kind: TemplateKind,
    now: Date,
  ) {
    const [s] = await tx
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(eq(suppressions.email, inv.email!));
    if (s) {
      await tx.update(invitations).set({ status: 'suppressed' }).where(eq(invitations.id, inv.id));
      return false;
    }
    const [c] = inv.caseId
      ? await tx.select({ sample: cases.sample }).from(cases).where(eq(cases.id, inv.caseId))
      : [];
    const settings = await this.cases.settings(tx, inv.projectId);
    const token = decryptField(inv.tokenEnc, this.config.APP_ENCRYPTION_KEY);
    const t = renderTemplate(await this.templateFor(tx, inv.projectId, kind, inv.language), {
      case: (c?.sample ?? {}) as Record<string, unknown>,
      link: this.clickUrl(token),
      unsubscribe: this.unsubscribeUrl(token),
    });
    const n = kind === 'invitation' ? 0 : inv.remindersSent + 1;
    try {
      await this.mailer.send({
        to: inv.email!,
        subject: t.subject,
        text: t.body,
        html: htmlBody(t.body, this.pixelUrl(token)),
        ...(settings.cawi.senderName ? { fromName: settings.cawi.senderName } : {}),
        headers: {
          'List-Unsubscribe': `<${this.unsubscribeUrl(token)}>`,
          'X-WanSurvey-Invitation': inv.id,
        },
        idempotencyKey: `inv:${inv.id}:${n}`,
      });
    } catch (e) {
      const attempts = inv.sendAttempts + 1;
      await tx
        .update(invitations)
        .set({
          sendAttempts: attempts,
          lastError: (e as Error).message.slice(0, 500),
          ...(attempts >= MAX_SEND_ATTEMPTS && kind === 'invitation' ? { status: 'failed' } : {}),
        })
        .where(eq(invitations.id, inv.id));
      return false;
    }
    await tx
      .update(invitations)
      .set(
        kind === 'invitation'
          ? { status: 'sent', sentAt: now, lastError: null }
          : { remindersSent: inv.remindersSent + 1, lastReminderAt: now },
      )
      .where(eq(invitations.id, inv.id));
    void tenantId;
    return true;
  }

  // -------------------------------------------------------------------------
  // Tracking, webhook, unsubscribe (no sign-in)
  // -------------------------------------------------------------------------

  private async byToken<T>(token: string, fn: (tx: Tx, inv: InvitationRow) => Promise<T>) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new NotFoundException('Link not found');
    const found = await this.database.invitationByToken(sha256Hex(token));
    if (!found) throw new NotFoundException('Link not found');
    return this.database.withTenant(found.tenantId, async (tx) => {
      const [inv] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.id, found.id))
        .for('update');
      return fn(tx, inv!);
    });
  }

  /** The open pixel (approximate: image blocking and proxies distort it, W2) and the click. */
  async track(token: string, kind: 'open' | 'click') {
    try {
      await this.byToken(token, async (tx, inv) => {
        const now = new Date();
        await tx
          .update(invitations)
          .set(
            kind === 'open'
              ? { openedAt: inv.openedAt ?? now }
              : { clickedAt: inv.clickedAt ?? now, openedAt: inv.openedAt ?? now },
          )
          .where(eq(invitations.id, inv.id));
      });
    } catch {
      // Tracking never fails the respondent.
    }
    return this.surveyUrl(token);
  }

  /** Delivery events from the mail provider (W3). */
  async webhook(body: z.infer<typeof WebhookBody>) {
    let applied = 0;
    for (const ev of body.events) {
      const tenantId = await this.database.invitationTenant(ev.invitationId);
      if (!tenantId) continue;
      await this.database.withTenant(tenantId, async (tx) => {
        const [inv] = await tx
          .select()
          .from(invitations)
          .where(eq(invitations.id, ev.invitationId))
          .for('update');
        if (!inv) return;
        const now = new Date();
        if (ev.type === 'delivered') {
          await tx
            .update(invitations)
            .set({ deliveredAt: inv.deliveredAt ?? now })
            .where(eq(invitations.id, inv.id));
        } else if (ev.type === 'bounce' && ev.bounceType !== 'hard') {
          await tx
            .update(invitations)
            .set({ bounceType: inv.bounceType ?? 'soft', lastError: ev.reason ?? 'soft bounce' })
            .where(eq(invitations.id, inv.id));
        } else {
          await this.suppress(
            tx,
            tenantId,
            inv.email,
            ev.type === 'complaint' ? 'complaint' : 'hard_bounce',
          );
          await tx
            .update(invitations)
            .set({
              status: inv.status === 'completed' ? inv.status : 'bounced',
              bouncedAt: now,
              bounceType: ev.type === 'complaint' ? 'complaint' : 'hard',
              lastError: ev.reason ?? null,
            })
            .where(eq(invitations.id, inv.id));
          if (ev.type === 'bounce' && inv.caseId && inv.waveId) {
            const [w] = await tx.select().from(waves).where(eq(waves.id, inv.waveId));
            await this.bounced(tx, tenantId, inv.caseId, !!w?.bouncesToCati);
          }
        }
        applied++;
      });
    }
    return { applied };
  }

  /** A hard bounce: the case is marked, and optionally moved to telephone interviewing. */
  private async bounced(tx: Tx, tenantId: string, caseId: string, toCati: boolean) {
    const [c] = await tx.select().from(cases).where(eq(cases.id, caseId));
    if (!c || c.status === 'finalised' || c.status === 'withdrawn') return;
    await tx
      .update(cases)
      .set({
        disposition: 'EMAIL_BOUNCED',
        ...(toCati ? { modePreference: 'CATI', nextContactAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(cases.id, caseId));
    await this.cases.events(tx, tenantId, null, [
      { caseId, type: 'email_bounced', details: { toCati } },
    ]);
  }

  private async suppress(tx: Tx, tenantId: string, email: string | null, reason: string) {
    if (!email) return;
    await tx
      .insert(suppressions)
      .values({ tenantId, email: lower(email), reason })
      .onConflictDoNothing();
  }

  /** What the unsubscribe page shows. */
  async unsubscribeInfo(token: string) {
    return this.byToken(token, async (tx, inv) => {
      const [s] = inv.email
        ? await tx.select().from(suppressions).where(eq(suppressions.email, inv.email))
        : [];
      return { email: maskEmail(inv.email), unsubscribed: !!s };
    });
  }

  async unsubscribe(token: string) {
    return this.byToken(token, async (tx, inv) => {
      await this.suppress(tx, inv.tenantId, inv.email, 'unsubscribe');
      if (inv.caseId)
        await this.cases.events(tx, inv.tenantId, null, [
          { caseId: inv.caseId, type: 'unsubscribed', details: { invitationId: inv.id } },
        ]);
      return { email: maskEmail(inv.email), unsubscribed: true };
    });
  }

  // -------------------------------------------------------------------------
  // Respondents
  // -------------------------------------------------------------------------

  private writer(inv: InvitationRow) {
    return { tenantId: inv.tenantId, userId: null, ctx: null };
  }

  /**
   * Opens the respondent's interview, creating it on first use. The browser's device id takes
   * the interview over, so a respondent can continue on another device with the same link.
   */
  async respondent(token: string, deviceId: string) {
    return this.byToken(token, async (tx, inv) => {
      const settings = await this.cases.settings(tx, inv.projectId);
      let row: InterviewRow | undefined;
      if (inv.interviewId)
        [row] = await tx.select().from(interviews).where(eq(interviews.id, inv.interviewId));
      if (!row) {
        if (inv.caseId) {
          const [c] = await tx
            .select({ status: cases.status })
            .from(cases)
            .where(eq(cases.id, inv.caseId));
          if (c?.status === 'finalised' || c?.status === 'withdrawn')
            throw new GoneException({ code: 'CASE_CLOSED', message: 'This survey is closed' });
        }
        row = await this.createInterview(tx, inv, deviceId);
      } else if (row.status === 'in_progress' && row.deviceId !== deviceId) {
        [row] = (await tx
          .update(interviews)
          .set({ deviceId, updatedAt: new Date() })
          .where(eq(interviews.id, row.id))
          .returning()) as [InterviewRow];
      }
      await tx
        .insert(interviewDevices)
        .values({ tenantId: inv.tenantId, interviewId: row.id, deviceId })
        .onConflictDoNothing();
      if (!inv.startedAt)
        await tx
          .update(invitations)
          .set({ startedAt: new Date() })
          .where(eq(invitations.id, inv.id));
      const p = await this.runtime.payload(tx, row, deviceId);
      return {
        interview: {
          id: p.interview.id,
          mode: p.interview.mode,
          language: p.interview.language,
          status: p.interview.status,
          startedAt: p.interview.startedAt,
          state: p.interview.state,
          activeMs: p.interview.activeMs,
          totalMs: p.interview.totalMs,
        },
        context: { case: (p.context as { case?: unknown }).case ?? {} },
        compiled: p.compiled,
        lastSeq: p.lastSeq,
        serverTime: p.serverTime,
        completion: {
          message: settings.cawi.completionMessage,
          redirectUrl: settings.cawi.redirectUrl,
        },
      };
    });
  }

  private async createInterview(tx: Tx, inv: InvitationRow, deviceId: string) {
    const version = await this.runtime.latestVersion(tx, inv.projectId, inv.questionnaireId);
    let sample: Record<string, unknown> = {};
    if (inv.caseId) {
      const [c] = await tx
        .select({ sample: cases.sample, externalId: cases.externalId })
        .from(cases)
        .where(eq(cases.id, inv.caseId));
      // The respondent's own record, for piping (W1).
      sample = (c?.sample ?? {}) as Record<string, unknown>;
    }
    const [row] = (await tx
      .insert(interviews)
      .values({
        id: uuidv7(),
        tenantId: inv.tenantId,
        projectId: inv.projectId,
        caseId: inv.caseId,
        questionnaireVersionId: version.id,
        mode: 'CAWI',
        interviewerId: null,
        language: inv.language,
        context: { case: sample },
        deviceId,
      })
      .returning()) as [InterviewRow];
    await tx.update(invitations).set({ interviewId: row.id }).where(eq(invitations.id, inv.id));
    if (inv.caseId) {
      await tx
        .update(cases)
        .set({ status: 'in_progress', updatedAt: new Date() })
        .where(and(eq(cases.id, inv.caseId), inArray(cases.status, ['fresh', 'assigned'])));
      await this.cases.events(tx, inv.tenantId, null, [
        {
          caseId: inv.caseId,
          type: 'interview_started',
          details: { interviewId: row.id, mode: 'CAWI', version: version.version },
        },
      ]);
    }
    return row;
  }

  async respondentSync(token: string, body: z.infer<typeof RespondentSync>) {
    return this.byToken(token, async (tx, inv) => {
      if (!inv.interviewId) throw new NotFoundException('Survey not started');
      const { deviceId, ...item } = body;
      return this.runtime.sync(
        tx,
        this.writer(inv),
        deviceId,
        [{ ...item, id: inv.interviewId }],
        (row) => (row.id === inv.interviewId ? null : 'NOT_FOUND'),
      );
    });
  }

  async respondentSubmit(token: string, body: SubmitBody) {
    return this.byToken(token, async (tx, inv) => {
      if (!inv.interviewId) throw new NotFoundException('Survey not started');
      const [row] = await tx
        .select()
        .from(interviews)
        .where(eq(interviews.id, inv.interviewId))
        .for('update');
      return this.runtime.submit(tx, row!, body, this.writer(inv));
    });
  }

  /** Starts an anonymous interview from an open link; the browser keeps the token (W6). */
  async openLinkStart(slug: string) {
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(slug)) throw new NotFoundException('Link not found');
    const found = await this.database.openLinkBySlug(slug);
    if (!found) throw new NotFoundException('Link not found');
    return this.database.withTenant(found.tenantId, async (tx) => {
      const [l] = await tx.select().from(openLinks).where(eq(openLinks.id, found.id));
      const v = await this.runtime.latestVersion(tx, l!.projectId, l!.questionnaireId);
      const { token, tokenHash, tokenEnc } = this.newToken();
      await tx.insert(invitations).values({
        tenantId: found.tenantId,
        projectId: l!.projectId,
        questionnaireId: l!.questionnaireId,
        tokenHash,
        tokenEnc,
        language: (v.compiled as CompiledQuestionnaire).questionnaire.defaultLanguage,
        status: 'sent',
        sentAt: new Date(),
      });
      return { token };
    });
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The text body as simple HTML, links made clickable, with the open pixel. */
function htmlBody(text: string, pixel: string) {
  const html = escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>\n');
  return `<!doctype html><html><body style="font-family:sans-serif;line-height:1.5">${html}<img src="${escapeHtml(pixel)}" width="1" height="1" alt=""></body></html>`;
}

function maskEmail(e: string | null) {
  if (!e) return null;
  const [user, domain] = e.split('@');
  return `${user!.slice(0, 2)}•••@${domain}`;
}
