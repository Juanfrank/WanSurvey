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
import { uuidv7 } from 'uuidv7';
import { projectSettings, type CawiTheme } from '@wansurvey/schema';
import { z } from 'zod';
import { DisplayName } from '../common/zod.js';
import { AuditService } from '../audit/audit.service.js';
import { compileRule, ruleError } from '../cases/case-logic.js';
import { CasesService } from '../cases/cases.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { decryptField, encryptField, randomToken, sha256Hex } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Engine } from '../db/engine.js';
import type { InterviewRow } from '../interviews/interviews-repo.js';
import { fieldedIn, InterviewsService } from '../interviews/interviews.service.js';
import {
  CAWI_REPO,
  type CawiRepo,
  type CawiTx,
  type InvitationView,
  type NewInvitationRow,
  type TargetView,
} from './cawi-repo.js';
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

type InvitationRow = InvitationView;
type TargetRow = TargetView;

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
    @Inject(CAWI_REPO) private readonly repo: CawiRepo,
    private readonly engine: Engine,
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
      await this.repo.extend(t).completeInvitation(row.id);
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

  private async languages(t: CawiTx, projectId: string) {
    const languages = await t.projectLanguages(projectId);
    if (!languages) throw new NotFoundException('Project not found');
    return [...new Set(['es', ...languages])];
  }

  /** Every kind × project language, the project's own wording or the default. */
  async templates(t: CawiTx, projectId: string) {
    const own = await t.ownTemplates(projectId);
    const out = [];
    for (const language of await this.languages(t, projectId))
      for (const kind of TEMPLATE_KINDS) {
        const x = own.find((o) => o.kind === kind && o.language === language);
        const d = defaultTemplate(kind, language);
        out.push({
          kind,
          language,
          subject: x?.subject ?? d.subject,
          body: x?.body ?? d.body,
          custom: !!x,
        });
      }
    return out;
  }

  async saveTemplate(
    t: CawiTx,
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
    await t.saveTemplate(projectId, ctx.userId, body);
    return this.templates(t, projectId);
  }

  private async templateFor(t: CawiTx, projectId: string, kind: TemplateKind, language: string) {
    return (await t.template(projectId, kind, language)) ?? defaultTemplate(kind, language);
  }

  // -------------------------------------------------------------------------
  // Waves
  // -------------------------------------------------------------------------

  async createWave(t: CawiTx, ctx: AuthContext, projectId: string, body: z.infer<typeof WaveBody>) {
    if (body.filter) {
      const err = ruleError(body.filter);
      if (err) throw new BadRequestException({ code: 'BAD_FILTER', message: err });
    }
    if (!(await t.hasQuestionnaire(projectId, body.questionnaireId)))
      throw new BadRequestException({ code: 'NOT_FOUND', message: 'Unknown questionnaire' });
    await this.runtime.latestVersion(t, projectId, body.questionnaireId, 'CAWI');
    return t.insertWave({
      projectId,
      questionnaireId: body.questionnaireId,
      name: body.name,
      filter: body.filter?.trim() || null,
      reminderDays: [...body.reminderDays].sort((a, b) => a - b),
      sendAt: body.sendAt ? new Date(body.sendAt) : null,
      bouncesToCati: body.bouncesToCati,
      channel: body.channel,
      createdBy: ctx.userId,
    });
  }

  /** Waves with their funnel: sent → delivered → opened → clicked → started → completed. */
  async listWaves(t: CawiTx, projectId: string) {
    const ws = await t.waves(projectId);
    const counts = await t.waveCounts(projectId);
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

  /** The cases of a wave that its rule lets through, with their samples opened. */
  private async candidatesOf(
    t: CawiTx,
    projectId: string,
    w: { questionnaireId: string; filter: string | null },
  ) {
    const match = compileRule(w.filter);
    return (await t.waveCandidates(projectId, w.questionnaireId))
      .map((r) => ({ ...r, sample: this.cases.pii.read(r) }))
      .filter(match);
  }

  /** The language of an invitation: the case's own when the questionnaire has it. */
  private languageOf(sample: Record<string, unknown>, compiled: CompiledQuestionnaire) {
    return typeof sample.language === 'string' &&
      compiled.questionnaire.languages.includes(sample.language)
      ? sample.language
      : compiled.questionnaire.defaultLanguage;
  }

  /**
   * Queues an invitation for every eligible case of the wave: matching its rule, not
   * finished, with a usable e-mail address that is not suppressed, and only once the project
   * has declared its lawful basis for e-mailing (W4). The dispatcher sends them.
   */
  async sendWave(t: CawiTx, ctx: AuthContext, projectId: string, waveId: string) {
    const settings = await this.cases.settings(t, projectId);
    if ((await t.waveChannel(projectId, waveId)) === 'links')
      return this.makeLinks(t, ctx, projectId, waveId);
    if (!settings.cawi.lawfulBasis)
      throw new BadRequestException({
        code: 'NO_LAWFUL_BASIS',
        message: 'Declare the lawful basis for e-mailing this sample first',
      });
    const w = await t.lockWave(projectId, waveId);
    if (!w) throw new NotFoundException('Wave not found');
    if (w.status !== 'draft')
      throw new ConflictException({ code: 'WAVE_SENT', message: 'This wave has been sent' });
    const v = await this.runtime.latestVersion(t, projectId, w.questionnaireId, 'CAWI');
    const compiled = v.compiled as CompiledQuestionnaire;
    const candidates = await this.candidatesOf(t, projectId, w);
    const emails = await t.emailContacts(candidates.map((c) => c.id));
    const suppressed = new Set(await t.suppressedEmails());
    const skipped = { noEmail: 0, suppressed: 0, optedOut: 0 };
    const rows: NewInvitationRow[] = [];
    for (const c of candidates) {
      const all = emails.filter((e) => e.caseId === c.id);
      const usable = all.filter((e) => (e.consent as { email?: boolean }).email !== false);
      const e = usable.find((x) => !suppressed.has(lower(x.value)));
      if (!all.length) skipped.noEmail++;
      else if (!usable.length) skipped.optedOut++;
      else if (!e) skipped.suppressed++;
      if (!e) continue;
      const { tokenHash, tokenEnc } = this.newToken();
      rows.push({
        projectId,
        questionnaireId: w.questionnaireId,
        waveId: w.id,
        caseId: c.id,
        contactId: e.id,
        email: lower(e.value),
        tokenHash,
        tokenEnc,
        language: this.languageOf(c.sample as Record<string, unknown>, compiled),
      });
    }
    await t.insertInvitations(rows);
    await t.setWaveStatus(w.id, 'sending');
    await this.cases.events(
      t,
      ctx.tenantId,
      ctx.userId,
      rows.map((r) => ({ caseId: r.caseId, type: 'invited', details: { waveId: w.id } })),
    );
    return { queued: rows.length, skipped };
  }

  /**
   * A "links only" wave: a personal link for every eligible case matching its rule, e-mail
   * or not. Nothing is sent; the links are listed and downloaded (W7).
   */
  private async makeLinks(t: CawiTx, ctx: AuthContext, projectId: string, waveId: string) {
    const w = await t.lockWave(projectId, waveId);
    if (!w) throw new NotFoundException('Wave not found');
    if (w.status !== 'draft')
      throw new ConflictException({ code: 'WAVE_SENT', message: 'This wave has been sent' });
    const v = await this.runtime.latestVersion(t, projectId, w.questionnaireId, 'CAWI');
    const compiled = v.compiled as CompiledQuestionnaire;
    const candidates = await this.candidatesOf(t, projectId, w);
    const rows: NewInvitationRow[] = candidates.map((c) => {
      const token = this.newToken();
      return {
        projectId,
        questionnaireId: w.questionnaireId,
        waveId: w.id,
        caseId: c.id,
        status: 'link',
        tokenHash: token.tokenHash,
        tokenEnc: token.tokenEnc,
        language: this.languageOf(c.sample as Record<string, unknown>, compiled),
      };
    });
    await t.insertInvitations(rows);
    await t.setWaveStatus(w.id, 'sent');
    await this.cases.events(
      t,
      ctx.tenantId,
      ctx.userId,
      rows.map((r) => ({ caseId: r.caseId, type: 'link_made', details: { waveId: w.id } })),
    );
    return { queued: 0, links: rows.length, skipped: { noEmail: 0, suppressed: 0, optedOut: 0 } };
  }

  /** The personal links of a wave, one per case, with how far each got. */
  async waveLinks(t: CawiTx, projectId: string, waveId: string) {
    const rows = await t.waveLinkRows(projectId, waveId);
    return rows.map((r) => ({
      externalId: r.externalId,
      url: this.surveyUrl(decryptField(r.tokenEnc, this.config.APP_ENCRYPTION_KEY)),
      status: r.completedAt ? 'completed' : r.startedAt ? 'started' : 'notStarted',
    }));
  }

  suppressionList(t: CawiTx) {
    return t.suppressionList();
  }

  // -------------------------------------------------------------------------
  // Open link (W6)
  // -------------------------------------------------------------------------

  async openLink(t: CawiTx, projectId: string) {
    const l = await t.openLinkOf(projectId);
    return l ? { ...l, url: `${this.webBase}/o/${l.slug}` } : null;
  }

  async setOpenLink(
    t: CawiTx,
    ctx: AuthContext,
    projectId: string,
    body: z.infer<typeof OpenLinkBody>,
  ) {
    const current = await this.openLink(t, projectId);
    // The questionnaire must be this project's, in use and fielded on the web.
    if (body.questionnaireId && body.questionnaireId !== current?.questionnaireId)
      await this.runtime.latestVersion(t, projectId, body.questionnaireId, 'CAWI');
    if (current) {
      await t.updateOpenLink(current.id, {
        active: body.active,
        ...(body.questionnaireId ? { questionnaireId: body.questionnaireId } : {}),
      });
    } else {
      if (!body.questionnaireId)
        throw new BadRequestException({ code: 'NOT_FOUND', message: 'Choose a questionnaire' });
      await t.insertOpenLink({
        projectId,
        questionnaireId: body.questionnaireId,
        slug: randomToken(9),
        active: body.active,
      });
    }
    return this.openLink(t, projectId);
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
    const batch = await this.repo.inTenant(tenantId, (t) => t.leaseBatch(now, limit, lease));

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
    await this.repo.inTenant(tenantId, (t) => t.markWavesSent());
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
    const prepared = await this.repo.inTenant(tenantId, async (t) => {
      if (await t.isSuppressed(inv.email!)) {
        await t.patchInvitation(inv.id, { status: 'suppressed', leaseUntil: null });
        return null;
      }
      const c = inv.caseId ? await t.caseSample(inv.caseId) : null;
      const settings = await once(`settings:${inv.projectId}`, () =>
        this.cases.settings(t, inv.projectId),
      );
      const template = await once(`template:${inv.projectId}:${kind}:${inv.language}`, () =>
        this.templateFor(t, inv.projectId, kind, inv.language),
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
      await this.repo.inTenant(tenantId, (t) =>
        t.patchInvitation(inv.id, {
          sendAttempts: attempts,
          lastError: (e as Error).message.slice(0, 500),
          leaseUntil: null,
          ...(attempts >= MAX_SEND_ATTEMPTS && kind === 'invitation' ? { status: 'failed' } : {}),
        }),
      );
      return false;
    }
    await this.repo.inTenant(tenantId, (t) =>
      t.patchInvitation(
        inv.id,
        kind === 'invitation'
          ? { status: 'sent', sentAt: now, lastError: null, leaseUntil: null }
          : { remindersSent: inv.remindersSent + 1, lastReminderAt: now, leaseUntil: null },
      ),
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // Tracking, webhook, unsubscribe (no sign-in)
  // -------------------------------------------------------------------------

  /** One transaction per respondent request: the token's organisation, then its invitation, locked. */
  private async byToken<T>(token: string, fn: (t: CawiTx, inv: InvitationRow) => Promise<T>) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new NotFoundException('Link not found');
    return this.repo.ofToken(sha256Hex(token), async (t, found) => {
      if (!found) throw new NotFoundException('Link not found');
      // The project comes with the link: the request reads it once (settings, logo, hooks).
      return fn(t, await t.lockLink(found.id));
    });
  }

  /**
   * A respondent's sync or submission: the invitation, its interview (both locked), the
   * project and the device's last acknowledged change, in the transaction's second statement.
   */
  private async surveyByToken<T>(
    token: string,
    deviceId: string,
    fn: (t: CawiTx, inv: InvitationRow, row: InterviewRow, lastSeq: number | null) => Promise<T>,
  ) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new NotFoundException('Link not found');
    return this.repo.ofToken(sha256Hex(token), async (t, found) => {
      if (!found) throw new NotFoundException('Link not found');
      const r = await t.lockSurvey(found.id, deviceId);
      if (!r) throw new NotFoundException('Survey not started');
      return fn(t, r.inv, r.interview, r.lastSeq);
    });
  }

  /**
   * The questionnaire a respondent starts and its version. In the usual case (active, with a
   * published version fielded on the web) one query answers; otherwise the full rules run
   * (continuation, closed questionnaire, errors), as `respondentTarget` and `latestVersion`.
   */
  private async startTarget(
    t: CawiTx,
    projectId: string,
    questionnaireId: string,
    known?: TargetRow,
  ): Promise<{
    questionnaireId: string;
    version: { id: string; version: number; compiled: CompiledQuestionnaire };
  }> {
    const row = known ?? (await t.questionnaireTarget(questionnaireId, projectId));
    if (row && !closedCode(row.state) && row.versionId) {
      const compiled = await this.runtime.compiledOf(t, row.versionId);
      if (fieldedIn(compiled, 'CAWI'))
        return {
          questionnaireId,
          version: { id: row.versionId, version: row.version!, compiled },
        };
    }
    const target = await this.respondentTarget(t, questionnaireId, projectId);
    const v = await this.runtime.latestVersion(t, projectId, target, 'CAWI');
    return {
      questionnaireId: target,
      version: { id: v.id, version: v.version, compiled: v.compiled as CompiledQuestionnaire },
    };
  }

  /** The open pixel (approximate: image blocking and proxies distort it, W2) and the click. */
  async track(token: string, kind: 'open' | 'click') {
    try {
      await this.byToken(token, async (t, inv) => {
        const now = new Date();
        await t.patchInvitation(
          inv.id,
          kind === 'open'
            ? { openedAt: inv.openedAt ?? now }
            : { clickedAt: inv.clickedAt ?? now, openedAt: inv.openedAt ?? now },
        );
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
      const tenantId = await this.engine.invitationTenant(ev.invitationId);
      if (!tenantId) continue;
      await this.repo.inTenant(tenantId, async (t) => {
        const inv = await t.lockInvitation(ev.invitationId);
        if (!inv) return;
        const now = new Date();
        if (ev.type === 'delivered') {
          await t.patchInvitation(inv.id, { deliveredAt: inv.deliveredAt ?? now });
        } else if (ev.type === 'bounce' && ev.bounceType !== 'hard') {
          await t.patchInvitation(inv.id, {
            bounceType: inv.bounceType ?? 'soft',
            lastError: ev.reason ?? 'soft bounce',
          });
        } else {
          await this.suppress(t, inv.email, ev.type === 'complaint' ? 'complaint' : 'hard_bounce');
          await t.patchInvitation(inv.id, {
            status: inv.status === 'completed' ? inv.status : 'bounced',
            bouncedAt: now,
            bounceType: ev.type === 'complaint' ? 'complaint' : 'hard',
            lastError: ev.reason ?? null,
          });
          if (ev.type === 'bounce' && inv.caseId && inv.waveId) {
            const w = await t.wave(inv.waveId);
            await this.bounced(t, tenantId, inv.caseId, !!w?.bouncesToCati);
          }
        }
        applied++;
      });
    }
    return { applied };
  }

  /** A hard bounce: the case is marked, and optionally moved to telephone interviewing. */
  private async bounced(t: CawiTx, tenantId: string, caseId: string, toCati: boolean) {
    if (!(await t.markBounced(caseId, toCati))) return;
    await this.cases.events(t, tenantId, null, [
      { caseId, type: 'email_bounced', details: { toCati } },
    ]);
  }

  private async suppress(t: CawiTx, email: string | null, reason: string) {
    if (!email) return;
    await t.suppress(lower(email), reason);
  }

  /** What the unsubscribe page shows. */
  async unsubscribeInfo(token: string) {
    return this.byToken(token, async (t, inv) => {
      const unsubscribed = inv.email ? await t.isSuppressed(inv.email) : false;
      return { email: maskEmail(inv.email), unsubscribed };
    });
  }

  async unsubscribe(token: string) {
    return this.byToken(token, async (t, inv) => {
      await this.suppress(t, inv.email, 'unsubscribe');
      if (inv.caseId)
        await this.cases.events(t, inv.tenantId, null, [
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
      if (inv.interviewId) row = (await tx.interview(inv.interviewId)) ?? undefined;
      if (!row) {
        if (inv.caseId) {
          const status = await tx.caseStatusOf(inv.caseId);
          if (status === 'finalised' || status === 'withdrawn')
            throw new GoneException({ code: 'CASE_CLOSED', message: 'This survey is closed' });
        }
        const target = await this.startTarget(tx, inv.projectId, inv.questionnaireId);
        // A completed questionnaire's respondents who had not started go to its continuation.
        if (target.questionnaireId !== inv.questionnaireId) {
          await tx.patchInvitation(inv.id, { questionnaireId: target.questionnaireId });
          inv = { ...inv, questionnaireId: target.questionnaireId };
        }
        row = await this.createInterview(tx, inv, deviceId, target.version);
        // createInterview set the invitation's interview and start time.
        inv = { ...inv, startedAt: inv.startedAt ?? new Date() };
      } else if (row.status === 'in_progress' && row.deviceId !== deviceId) {
        row = await tx.takeOver(row.id, { deviceId, now: new Date() });
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
      if (!inv.startedAt) await tx.patchInvitation(inv.id, { startedAt: new Date() });
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
      const logo = await tx.logo(inv.projectId);
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
    tx: CawiTx,
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
    await tx.setInterviewContext(row.id, { ...context, params });
    return params;
  }

  private async createInterview(
    tx: CawiTx,
    inv: InvitationRow,
    deviceId: string,
    version: { id: string; version: number; compiled: CompiledQuestionnaire },
  ) {
    let sample: Record<string, unknown> = {};
    if (inv.caseId) {
      const c = await tx.casePiping(inv.caseId);
      // The respondent's own record, for piping (W1): only the fields the questionnaire uses,
      // so a forwarded link shows nothing else of the case.
      sample = c
        ? caseFieldsFor(version.compiled as CompiledQuestionnaire, this.cases.pii.read(c))
        : {};
    }
    const row = await tx.insertInterview({
      id: uuidv7(),
      projectId: inv.projectId,
      caseId: inv.caseId,
      questionnaireVersionId: version.id,
      mode: 'CAWI',
      interviewerId: null,
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
    await tx.startInvitation(inv.id, row.id);
    if (inv.caseId) {
      await tx.startCase(inv.caseId);
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
  private async respondentTarget(tx: CawiTx, questionnaireId: string, projectId: string) {
    const q = await tx.questionnaireState(questionnaireId);
    const code = closedCode(q?.state);
    if (!code) return questionnaireId;
    if (code === 'QUESTIONNAIRE_COMPLETED' && q!.successorId) {
      const next = await tx.questionnaireState(q!.successorId);
      if (next?.state === 'active') return q!.successorId;
    }
    let next: string | null = null;
    const link = await this.openLink(tx, projectId);
    if (link?.active && link.questionnaireId !== questionnaireId) {
      const l = await tx.questionnaireState(link.questionnaireId);
      if (l?.state === 'active') next = `/o/${link.slug}`;
    }
    throw new GoneException({ code, message: 'This survey is closed', next });
  }

  /** Starts an anonymous interview from an open link; the browser keeps the token (W6). */
  async openLinkStart(slug: string) {
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(slug)) throw new NotFoundException('Link not found');
    return this.repo.ofOpenLink(slug, async (tx, found) => {
      if (!found) throw new NotFoundException('Link not found');
      // The link, its questionnaire's state and latest version, in one query.
      const l = (await tx.openLinkTarget(found.id))!;
      // A completed questionnaire's link goes on with its continuation.
      const { questionnaireId, version } = await this.startTarget(
        tx,
        l.projectId,
        l.questionnaireId,
        l,
      );
      const { token, tokenHash, tokenEnc } = this.newToken();
      await tx.insertOpenInvitation({
        projectId: l.projectId,
        questionnaireId,
        tokenHash,
        tokenEnc,
        language: version.compiled.questionnaire.defaultLanguage,
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
