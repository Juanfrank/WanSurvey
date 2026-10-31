import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { projectSettings, type CawiTheme } from '@wansurvey/schema';
import { z } from 'zod';
import { DisplayName } from '../common/zod.js';
import { AuditService } from '../audit/audit.service.js';
import { compileRule, ruleError } from '../cases/case-logic.js';
import { CasesService, ofQuestionnaire } from '../cases/cases.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { decryptField, encryptField, randomToken, sha256Hex } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { columnsAs, Database, Prepared, type Tx } from '../db/database.js';
import { rememberProject, type ProjectRow } from '../cases/project-memo.js';
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
  fieldedIn,
  InterviewsService,
  type InterviewRow,
} from '../interviews/interviews.service.js';
import { closedCode } from '../questionnaires/state.js';
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
  name: DisplayName,
  questionnaireId: z.uuid(),
  filter: z.string().max(2000).optional(),
  reminderDays: z.array(z.number().int().min(1).max(90)).max(5).default([]),
  sendAt: z.iso.datetime({ offset: true }).optional(),
  bouncesToCati: z.boolean().default(false),
  /** email: invitations are sent; links: a personal link per case, nothing sent. */
  channel: z.enum(['email', 'links']).default('email'),
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
/** How long a dispatcher keeps the invitations it took; after that another run may take them. */
const DISPATCH_LEASE_MS = 10 * 60_000;

type InvitationRow = typeof invitations.$inferSelect;

const lower = (e: string) => e.trim().toLowerCase();

/**
 * Web surveys by e-mail (spec §6.4, §8; decisions W1–W7): templates, waves of invitations
 * with reminders, delivery tracking, bounces and unsubscribes, and the respondent's side of
 * the interview runtime, reached with a link token instead of a sign-in.
 */
@Injectable()
export class CawiService implements OnModuleInit {
  private readonly logger = new Logger('Cawi');

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
    this.runtime.onSubmitted(async (t, row) => {
      if (row.mode !== 'CAWI') return;
      await completeInvitation.run(t.native(), { interview: row.id });
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
    await this.runtime.latestVersion(tx, projectId, body.questionnaireId, 'CAWI');
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
        channel: body.channel,
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
    const [peek] = await tx
      .select({ channel: waves.channel })
      .from(waves)
      .where(and(eq(waves.id, waveId), eq(waves.projectId, projectId)));
    if (peek?.channel === 'links') return this.makeLinks(tx, ctx, projectId, waveId);
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
    const v = await this.runtime.latestVersion(tx, projectId, w.questionnaireId, 'CAWI');
    const compiled = v.compiled as CompiledQuestionnaire;
    const match = compileRule(w.filter);
    const candidates = (
      await tx
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
            ofQuestionnaire(w.questionnaireId),
            inArray(cases.status, ['fresh', 'assigned']),
          ),
        )
        .orderBy(asc(cases.externalId))
    )
      .map((r) => ({ ...r, sample: this.cases.pii.read(r) }))
      .filter(match);
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

  /**
   * A "links only" wave: a personal link for every eligible case matching its rule, e-mail
   * or not. Nothing is sent; the links are listed and downloaded (W7).
   */
  private async makeLinks(tx: Tx, ctx: AuthContext, projectId: string, waveId: string) {
    const [w] = await tx
      .select()
      .from(waves)
      .where(and(eq(waves.id, waveId), eq(waves.projectId, projectId)))
      .for('update');
    if (!w) throw new NotFoundException('Wave not found');
    if (w.status !== 'draft')
      throw new ConflictException({ code: 'WAVE_SENT', message: 'This wave has been sent' });
    const v = await this.runtime.latestVersion(tx, projectId, w.questionnaireId, 'CAWI');
    const compiled = v.compiled as CompiledQuestionnaire;
    const match = compileRule(w.filter);
    const candidates = (
      await tx
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
            ofQuestionnaire(w.questionnaireId),
            inArray(cases.status, ['fresh', 'assigned']),
          ),
        )
        .orderBy(asc(cases.externalId))
    )
      .map((r) => ({ ...r, sample: this.cases.pii.read(r) }))
      .filter(match);
    const rows: (typeof invitations.$inferInsert)[] = candidates.map((c) => {
      const t = this.newToken();
      const sample = c.sample as Record<string, unknown>;
      const language =
        typeof sample.language === 'string' &&
        compiled.questionnaire.languages.includes(sample.language)
          ? sample.language
          : compiled.questionnaire.defaultLanguage;
      return {
        tenantId: ctx.tenantId,
        projectId,
        questionnaireId: w.questionnaireId,
        waveId: w.id,
        caseId: c.id,
        status: 'link',
        tokenHash: t.tokenHash,
        tokenEnc: t.tokenEnc,
        language,
      };
    });
    for (let i = 0; i < rows.length; i += 500)
      await tx
        .insert(invitations)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing();
    await tx.update(waves).set({ status: 'sent', sentAt: new Date() }).where(eq(waves.id, w.id));
    await this.cases.events(
      tx,
      ctx.tenantId,
      ctx.userId,
      rows.map((r) => ({ caseId: r.caseId!, type: 'link_made', details: { waveId: w.id } })),
    );
    return { queued: 0, links: rows.length, skipped: { noEmail: 0, suppressed: 0, optedOut: 0 } };
  }

  /** The personal links of a wave, one per case, with how far each got. */
  async waveLinks(tx: Tx, projectId: string, waveId: string) {
    const rows = await tx
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
    return rows.map((r) => ({
      externalId: r.externalId,
      url: this.surveyUrl(decryptField(r.tokenEnc, this.config.APP_ENCRYPTION_KEY)),
      status: r.completedAt ? 'completed' : r.startedAt ? 'started' : 'notStarted',
    }));
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
    // The questionnaire must be this project's, in use and fielded on the web.
    if (body.questionnaireId && body.questionnaireId !== current?.questionnaireId)
      await this.runtime.latestVersion(tx, projectId, body.questionnaireId, 'CAWI');
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

  /**
   * Sends queued invitations and due reminders of one organisation. Returns how many went out.
   * A batch is taken under a lease in one short transaction; then each message is prepared,
   * sent and recorded on its own, so a lost worker or a failed commit resends at most the one
   * message in flight, and no row stays locked while the mail server answers.
   */
  async dispatch(tenantId: string, now = new Date(), limit = DISPATCH_BATCH) {
    const lease = new Date(now.getTime() + DISPATCH_LEASE_MS);
    const free = sql`(${invitations.leaseUntil} is null or ${invitations.leaseUntil} < ${now.toISOString()}::timestamptz)`;
    const active = sql`exists (select 1 from questionnaires qq where qq.id = ${invitations.questionnaireId}
                and qq.state = 'active')`;
    const batch = await this.database.withTenant(tenantId, async (tx) => {
      const queued = await tx
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
      const due = await tx
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
        ...queued.map((r) => ({ inv: r.inv, kind: 'invitation' as TemplateKind })),
        ...due.map((r) => ({ inv: r.inv, kind: 'reminder' as TemplateKind })),
      ];
      if (items.length)
        await tx
          .update(invitations)
          .set({ leaseUntil: lease })
          .where(
            inArray(
              invitations.id,
              items.map((i) => i.inv.id),
            ),
          );
      return items;
    });

    let sent = 0;
    const memo = new Map<string, Promise<unknown>>();
    for (const { inv, kind } of batch) {
      try {
        if (await this.sendOne(tenantId, inv, kind, now, memo)) sent++;
      } catch (e) {
        // The lease runs out and a later run tries again.
        this.logger.error(`Invitation ${inv.id} not sent: ${(e as Error).message}`);
      }
    }

    // Waves whose invitations have all left are sent.
    await this.database.withTenant(tenantId, (tx) =>
      tx.execute(sql`
        update waves set status = 'sent'
        where status = 'sending' and not exists (
          select 1 from invitations i where i.wave_id = waves.id and i.status = 'queued')`),
    );
    return sent;
  }

  /** Prepares one message (short transaction), sends it (none), records the result (short). */
  private async sendOne(
    tenantId: string,
    inv: InvitationRow,
    kind: TemplateKind,
    now: Date,
    memo: Map<string, Promise<unknown>>,
  ) {
    const once = <T>(key: string, load: () => Promise<T>) => {
      if (!memo.has(key)) memo.set(key, load());
      return memo.get(key) as Promise<T>;
    };
    const prepared = await this.database.withTenant(tenantId, async (tx) => {
      const [s] = await tx
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(eq(suppressions.email, inv.email!));
      if (s) {
        await tx
          .update(invitations)
          .set({ status: 'suppressed', leaseUntil: null })
          .where(eq(invitations.id, inv.id));
        return null;
      }
      const [c] = inv.caseId
        ? await tx
            .select({ sample: cases.sample, samplePii: cases.samplePii })
            .from(cases)
            .where(eq(cases.id, inv.caseId))
        : [];
      const settings = await once(`settings:${inv.projectId}`, () =>
        this.cases.settings(tx, inv.projectId),
      );
      const template = await once(`template:${inv.projectId}:${kind}:${inv.language}`, () =>
        this.templateFor(tx, inv.projectId, kind, inv.language),
      );
      return { case: c ? this.cases.pii.read(c) : {}, settings, template };
    });
    if (!prepared) return false;
    const token = decryptField(inv.tokenEnc, this.config.APP_ENCRYPTION_KEY);
    const t = renderTemplate(prepared.template, {
      case: prepared.case,
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
        ...(prepared.settings.cawi.senderName
          ? { fromName: prepared.settings.cawi.senderName }
          : {}),
        headers: {
          'List-Unsubscribe': `<${this.unsubscribeUrl(token)}>`,
          'X-WanSurvey-Invitation': inv.id,
        },
        idempotencyKey: `inv:${inv.id}:${n}`,
      });
    } catch (e) {
      const attempts = inv.sendAttempts + 1;
      await this.database.withTenant(tenantId, (tx) =>
        tx
          .update(invitations)
          .set({
            sendAttempts: attempts,
            lastError: (e as Error).message.slice(0, 500),
            leaseUntil: null,
            ...(attempts >= MAX_SEND_ATTEMPTS && kind === 'invitation' ? { status: 'failed' } : {}),
          })
          .where(eq(invitations.id, inv.id)),
      );
      return false;
    }
    await this.database.withTenant(tenantId, (tx) =>
      tx
        .update(invitations)
        .set(
          kind === 'invitation'
            ? { status: 'sent', sentAt: now, lastError: null, leaseUntil: null }
            : { remindersSent: inv.remindersSent + 1, lastReminderAt: now, leaseUntil: null },
        )
        .where(eq(invitations.id, inv.id)),
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // Tracking, webhook, unsubscribe (no sign-in)
  // -------------------------------------------------------------------------

  /** One transaction per respondent request: the token's organisation, then its invitation, locked. */
  private async byToken<T>(token: string, fn: (tx: Tx, inv: InvitationRow) => Promise<T>) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new NotFoundException('Link not found');
    return this.database.withTenantOf(
      'invitation_by_token',
      sha256Hex(token),
      async (tx, found) => {
        if (!found) throw new NotFoundException('Link not found');
        const [r] = await lockLink.run(tx, { id: found.id });
        // The project comes with the link: the request reads it once (settings, logo, hooks).
        rememberProject(tx, r!.project);
        return fn(tx, r!.inv);
      },
    );
  }

  /**
   * A respondent's sync or submission: the invitation, its interview (both locked), the
   * project and the device's last acknowledged change, in the transaction's second statement.
   */
  private async surveyByToken<T>(
    token: string,
    deviceId: string,
    fn: (tx: Tx, inv: InvitationRow, row: InterviewRow, lastSeq: number | null) => Promise<T>,
  ) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new NotFoundException('Link not found');
    return this.database.withTenantOf(
      'invitation_by_token',
      sha256Hex(token),
      async (tx, found) => {
        if (!found) throw new NotFoundException('Link not found');
        const [r] = await lockSurvey.run(tx, { id: found.id, device: deviceId });
        if (!r) throw new NotFoundException('Survey not started');
        rememberProject(tx, r.project);
        return fn(tx, r.inv, r.interview, r.lastSeq);
      },
    );
  }

  /**
   * The questionnaire a respondent starts and its version. In the usual case (active, with a
   * published version fielded on the web) one query answers; otherwise the full rules run
   * (continuation, closed questionnaire, errors), as `respondentTarget` and `latestVersion`.
   */
  private async startTarget(
    tx: Tx,
    projectId: string,
    questionnaireId: string,
    known?: TargetRow,
  ): Promise<{
    questionnaireId: string;
    version: { id: string; version: number; compiled: CompiledQuestionnaire };
  }> {
    const t =
      known ?? (await questionnaireTarget.run(tx, { qid: questionnaireId, project: projectId }))[0];
    if (t && !closedCode(t.state) && t.versionId) {
      const compiled = await this.runtime.compiledOf(tx, t.versionId);
      if (fieldedIn(compiled, 'CAWI'))
        return { questionnaireId, version: { id: t.versionId, version: t.version!, compiled } };
    }
    const target = await this.respondentTarget(tx, questionnaireId, projectId);
    const v = await this.runtime.latestVersion(tx, projectId, target, 'CAWI');
    return {
      questionnaireId: target,
      version: { id: v.id, version: v.version, compiled: v.compiled as CompiledQuestionnaire },
    };
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
  async respondent(token: string, deviceId: string, linkQuery = '') {
    return this.byToken(token, async (tx, inv) => {
      // The project once (read with the link): its settings, its logo and the interview's.
      const project = await this.cases.project(tx, inv.projectId);
      const settings = projectSettings(project.settings);
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
        const target = await this.startTarget(tx, inv.projectId, inv.questionnaireId);
        // A completed questionnaire's respondents who had not started go to its continuation.
        if (target.questionnaireId !== inv.questionnaireId) {
          await tx
            .update(invitations)
            .set({ questionnaireId: target.questionnaireId })
            .where(eq(invitations.id, inv.id));
          inv = { ...inv, questionnaireId: target.questionnaireId };
        }
        row = await this.createInterview(tx, inv, deviceId, target.version);
        // createInterview set the invitation's interview and start time.
        inv = { ...inv, startedAt: inv.startedAt ?? new Date() };
      } else if (row.status === 'in_progress' && row.deviceId !== deviceId) {
        [row] = (await tx
          .update(interviews)
          .set({ deviceId, updatedAt: new Date() })
          .where(eq(interviews.id, row.id))
          .returning()) as [InterviewRow];
      }
      const completion = {
        message: settings.cawi.completionMessage,
        redirectUrl: settings.cawi.redirectUrl,
      };
      const branding = this.branding(project.logoUpdatedAt, settings.cawi.theme, token);
      // A finished survey says so and nothing more: its answers and the respondent's record
      // are not handed to whoever holds the link.
      if (row.status !== 'in_progress')
        return {
          interview: {
            id: row.id,
            mode: row.mode,
            language: row.language,
            status: row.status,
            startedAt: row.startedAt,
            state: {},
            stateVersion: 0,
            ownState: false,
            activeMs: 0,
            totalMs: 0,
          },
          context: { case: {}, params: {} },
          compiled: await this.runtime.compiledOf(tx, row.questionnaireVersionId),
          lastSeq: 0,
          serverTime: new Date().toISOString(),
          completion,
          branding,
        };
      const lastSeq = await this.runtime.touchDevice(tx, inv.tenantId, row.id, deviceId);
      if (!inv.startedAt)
        await tx
          .update(invitations)
          .set({ startedAt: new Date() })
          .where(eq(invitations.id, inv.id));
      const p = await this.runtime.payload(tx, row, deviceId, settings, lastSeq);
      const params = await this.keepParams(tx, row, p.compiled, linkQuery);
      return {
        interview: {
          id: p.interview.id,
          mode: p.interview.mode,
          language: p.interview.language,
          status: p.interview.status,
          startedAt: p.interview.startedAt,
          state: p.interview.state,
          stateVersion: p.interview.stateVersion,
          ownState: p.interview.ownState,
          activeMs: p.interview.activeMs,
          totalMs: p.interview.totalMs,
        },
        context: { case: p.context.case ?? {}, params },
        compiled: p.compiled,
        lastSeq: p.lastSeq,
        serverTime: p.serverTime,
        completion,
        branding,
      };
    });
  }

  /** The project's look for respondents: the theme, and the logo's address when there is one. */
  private branding(at: Date | null, theme: CawiTheme, token: string) {
    return {
      theme,
      logo:
        at && theme.logo !== 'hidden'
          ? `/api/v1/public/s/${encodeURIComponent(token)}/logo?v=${at.getTime()}`
          : null,
    };
  }

  /** The logo of the link's project, for the respondent's page. */
  respondentLogo(token: string) {
    return this.byToken(token, async (tx, inv) => {
      const [logo] = await tx
        .select({ contentType: projectLogos.contentType, image: projectLogos.image })
        .from(projectLogos)
        .where(eq(projectLogos.projectId, inv.projectId));
      if (!logo) throw new NotFoundException('No logo');
      return logo;
    });
  }

  /**
   * The link's parameters (`?sede=2`), kept with the interview: the first link that brings
   * any of the questionnaire's parameters sets them, and later visits (with other values, or
   * none, or from another device) get the same ones, so the answers they give cannot change.
   */
  private async keepParams(
    tx: Tx,
    row: InterviewRow,
    compiled: CompiledQuestionnaire,
    linkQuery: string,
  ): Promise<Record<string, string>> {
    const context = row.context as { params?: Record<string, string> };
    if (context.params || row.status !== 'in_progress') return context.params ?? {};
    const names = new Set<string>();
    for (const n of compiled.nodes)
      if (n.kind === 'question') {
        const name = (n.def as { urlParam?: string }).urlParam;
        if (name) names.add(name);
      }
    const params: Record<string, string> = {};
    new URLSearchParams(linkQuery).forEach((v, k) => {
      if (names.has(k) && !(k in params)) params[k] = v.slice(0, 200);
    });
    if (!Object.keys(params).length) return {};
    await tx
      .update(interviews)
      .set({ context: { ...context, params } })
      .where(eq(interviews.id, row.id));
    return params;
  }

  private async createInterview(
    tx: Tx,
    inv: InvitationRow,
    deviceId: string,
    version: { id: string; version: number; compiled: CompiledQuestionnaire },
  ) {
    let sample: Record<string, unknown> = {};
    if (inv.caseId) {
      const [c] = await tx
        .select({ sample: cases.sample, samplePii: cases.samplePii, externalId: cases.externalId })
        .from(cases)
        .where(eq(cases.id, inv.caseId));
      // The respondent's own record, for piping (W1): only the fields the questionnaire uses,
      // so a forwarded link shows nothing else of the case.
      sample = c
        ? caseFieldsFor(version.compiled as CompiledQuestionnaire, this.cases.pii.read(c))
        : {};
    }
    const [row] = await insertInterview.run(tx, {
      id: uuidv7(),
      tenantId: inv.tenantId,
      projectId: inv.projectId,
      caseId: inv.caseId,
      versionId: version.id,
      language: inv.language,
      // Sealed as the case's personal fields are (`InterviewsService.contextOf` opens it).
      context: Object.keys(sample).length
        ? {
            case: {},
            casePii: encryptField(JSON.stringify(sample), this.config.APP_ENCRYPTION_KEY),
          }
        : { case: {} },
      deviceId,
    });
    // The interview and the start time in one update of the invitation.
    await startInvitation.run(tx, { id: inv.id, interview: row!.id });
    if (inv.caseId) {
      await tx
        .update(cases)
        .set({ status: 'in_progress', updatedAt: new Date() })
        .where(and(eq(cases.id, inv.caseId), inArray(cases.status, ['fresh', 'assigned'])));
      await this.cases.events(tx, inv.tenantId, null, [
        {
          caseId: inv.caseId,
          type: 'interview_started',
          details: { interviewId: row!.id, mode: 'CAWI', version: version.version },
        },
      ]);
    }
    return row!;
  }

  async respondentSync(token: string, body: z.infer<typeof RespondentSync>) {
    const { deviceId, ...item } = body;
    return this.surveyByToken(token, deviceId, async (tx, inv, row) =>
      this.runtime.sync(
        tx,
        this.writer(inv),
        deviceId,
        [{ ...item, id: row.id }],
        (r) => (r.id === inv.interviewId ? null : 'NOT_FOUND'),
        undefined,
        row,
      ),
    );
  }

  async respondentSubmit(token: string, body: SubmitBody) {
    return this.surveyByToken(token, body.deviceId, async (tx, inv, row, lastSeq) =>
      this.runtime.submit(tx, row, body, this.writer(inv), { lastSeq: lastSeq ?? 0 }),
    );
  }

  /**
   * The questionnaire a respondent starts: this one, or for a completed one the questionnaire
   * it continues in. A disabled one, or a completed one without continuation, answers 410 with
   * the reason and, when the project's open link leads somewhere open, where to go on (`next`).
   */
  private async respondentTarget(tx: Tx, questionnaireId: string, projectId: string) {
    const state = async (id: string) =>
      (
        await tx
          .select({ state: questionnaires.state, successorId: questionnaires.successorId })
          .from(questionnaires)
          .where(eq(questionnaires.id, id))
      )[0];
    const q = await state(questionnaireId);
    const code = closedCode(q?.state);
    if (!code) return questionnaireId;
    if (code === 'QUESTIONNAIRE_COMPLETED' && q!.successorId) {
      const next = await state(q!.successorId);
      if (next?.state === 'active') return q!.successorId;
    }
    let next: string | null = null;
    const link = await this.openLink(tx, projectId);
    if (link?.active && link.questionnaireId !== questionnaireId) {
      const l = await state(link.questionnaireId);
      if (l?.state === 'active') next = `/o/${link.slug}`;
    }
    throw new GoneException({ code, message: 'This survey is closed', next });
  }

  /** Starts an anonymous interview from an open link; the browser keeps the token (W6). */
  async openLinkStart(slug: string) {
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(slug)) throw new NotFoundException('Link not found');
    return this.database.withTenantOf('open_link_by_slug', slug, async (tx, found) => {
      if (!found) throw new NotFoundException('Link not found');
      // The link, its questionnaire's state and latest version, in one query.
      const [l] = await openLinkTarget.run(tx, { id: found.id });
      // A completed questionnaire's link goes on with its continuation.
      const { questionnaireId, version } = await this.startTarget(
        tx,
        l!.projectId,
        l!.questionnaireId,
        l,
      );
      const { token, tokenHash, tokenEnc } = this.newToken();
      await insertOpenInvitation.run(tx, {
        id: uuidv7(),
        tenantId: found.tenantId,
        projectId: l!.projectId,
        questionnaireId,
        tokenHash,
        tokenEnc,
        language: version.compiled.questionnaire.defaultLanguage,
      });
      return { token };
    });
  }
}

// The queries of every respondent request, built once (see Prepared).

/** The invitation, locked, with its project. */
const lockLink = new Prepared<{ inv: InvitationRow; project: ProjectRow }>(
  () => sql`
    select ${columnsAs(invitations, 'inv', 'inv')}, ${columnsAs(projects, 'p', 'project')}
    from invitations inv join projects p on p.id = inv.project_id
    where inv.id = ${sql.placeholder('id')}
    for update of inv`,
  { inv: getTableColumns(invitations), project: getTableColumns(projects) },
);

/** For syncs and submissions: the invitation and its interview, locked, the project and the device's number. */
const lockSurvey = new Prepared<{
  inv: InvitationRow;
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

type TargetRow = {
  state: string;
  successorId: string | null;
  versionId: string | null;
  version: number | null;
};

/** A questionnaire's state and its latest published version. */
const questionnaireTarget = new Prepared<TargetRow>(
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
const openLinkTarget = new Prepared<TargetRow & { projectId: string; questionnaireId: string }>(
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

const insertOpenInvitation = new Prepared<never>(
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

const insertInterview = new Prepared<InterviewRow>(
  (tx) =>
    tx
      .insert(interviews)
      .values({
        id: sql.placeholder('id'),
        tenantId: sql.placeholder('tenantId'),
        projectId: sql.placeholder('projectId'),
        caseId: sql.placeholder('caseId'),
        questionnaireVersionId: sql.placeholder('versionId'),
        mode: 'CAWI',
        interviewerId: null,
        language: sql.placeholder('language'),
        context: sql.placeholder('context'),
        deviceId: sql.placeholder('deviceId'),
      })
      .returning(),
  getTableColumns(interviews),
);

const startInvitation = new Prepared<never>(
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

const completeInvitation = new Prepared<never>(
  (tx) =>
    tx
      .update(invitations)
      .set({ status: 'completed', completedAt: sql`now()` })
      .where(eq(invitations.interviewId, sql.placeholder('interview'))),
  {},
);

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

/** Case fields a questionnaire reads (`case.<field>`, and the name fields `respondent.*` uses). */
export function caseFieldsFor(
  compiled: CompiledQuestionnaire,
  sample: Record<string, unknown>,
): Record<string, unknown> {
  const text = JSON.stringify(compiled.questionnaire);
  const used = new Set([...text.matchAll(/\bcase\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
  if (/\brespondent\./.test(text))
    for (const f of ['first_name', 'last_name', 'nombre', 'apellido']) used.add(f);
  return Object.fromEntries(Object.entries(sample).filter(([k]) => used.has(k)));
}
