import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import type { AuthContext } from '../common/auth-context.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { JobsService } from '../jobs/jobs.service.js';
import { resolveTarget, UnsafeUrlError } from '../webhooks/url-guard.js';
import { post } from '../webhooks/webhooks.service.js';
import { enqueuePush, PUSH_CATEGORIES, type PushCategory } from './outbox.js';
import { encryptPayload, vapidAuthorization } from './webpush.js';

/** Waits before each new try: 1, 5 and 30 minutes; then the notification is dropped. */
export const PUSH_RETRY_MINUTES = [1, 5, 30];
const BATCH = 50;
const CLAIM_MS = 60_000;
const TTL_SECONDS = 3600;
/** A callback due within this many minutes is announced. */
const CALLBACK_AHEAD_MS = 5 * 60_000;

export interface SubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  categories: PushCategory[];
  lang: string;
  userAgent?: string;
}

const hashOf = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');

/** Generic text only: what happened and how many, never a name or an answer. */
export function messageFor(
  category: PushCategory | 'test',
  data: { count?: number; url: string },
  lang: string,
): { title: string; body: string; url: string; tag: string } {
  const n = data.count ?? 1;
  const es = !lang.startsWith('en');
  const text: Record<string, [string, string]> = {
    callbacks: es
      ? [
          'Llamadas pendientes',
          n === 1 ? 'Tiene 1 llamada por hacer pronto.' : `Tiene ${n} llamadas por hacer pronto.`,
        ]
      : [
          'Callbacks due',
          n === 1 ? 'You have 1 callback due soon.' : `You have ${n} callbacks due soon.`,
        ],
    assignments: es
      ? ['Casos nuevos', n === 1 ? 'Le asignaron 1 caso.' : `Le asignaron ${n} casos.`]
      : ['New cases', n === 1 ? '1 case was assigned to you.' : `${n} cases were assigned to you.`],
    returned: es
      ? ['Entrevista devuelta', 'Una de sus entrevistas fue devuelta para corregir.']
      : ['Interview returned', 'One of your interviews was returned for fixing.'],
    exports: es
      ? ['Exportación lista', 'Su exportación ya se puede descargar.']
      : ['Export ready', 'Your export is ready to download.'],
    test: es
      ? ['Notificaciones activadas', 'Así se verán los avisos de WanSurvey.']
      : ['Notifications on', 'This is how WanSurvey notices will look.'],
  };
  const [title, body] = text[category]!;
  return { title, body, url: data.url, tag: category };
}

/**
 * Web notifications (ADR 0001, decision 6): subscriptions per person and browser, a dispatcher
 * that sends what the outbox holds (tried again if the push service is down, forgotten if the
 * browser says it is gone), and the one-minute look at the callbacks about to be due.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly engine: Engine,
    private readonly jobs: JobsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  get enabled() {
    return !!this.config.VAPID_PUBLIC_KEY && !!this.config.VAPID_PRIVATE_KEY;
  }

  onModuleInit() {
    if (!this.enabled) return;
    this.jobs.register('push.deliver', () => this.deliverDue());
    this.jobs.schedule('push.deliver', { everyMs: 15_000 });
    this.jobs.register('push.callbacks', () => this.callbacksDue());
    this.jobs.schedule('push.callbacks', { everyMs: 60_000 });
  }

  private get allowPrivate() {
    return this.config.WEBHOOK_ALLOW_PRIVATE_URLS === 'true';
  }

  // The person's side

  clientConfig() {
    return { enabled: this.enabled, publicKey: this.enabled ? this.config.VAPID_PUBLIC_KEY : null };
  }

  async state(ctx: AuthContext, endpoint: string) {
    const row = await this.engine.sql.withTenant(ctx.tenantId, (tx) =>
      tx
        .selectFrom('push_subscriptions')
        .select(['categories'])
        .where('user_id', '=', ctx.userId)
        .where('endpoint_hash', '=', hashOf(endpoint))
        .executeTakeFirst(),
    );
    return { subscribed: !!row, categories: row ? (JSON.parse(row.categories) as string[]) : [] };
  }

  async subscribe(ctx: AuthContext, body: SubscribeBody) {
    if (!this.enabled)
      throw new BadRequestException({ code: 'PUSH_OFF', message: 'Notifications are not set up' });
    try {
      await resolveTarget(body.endpoint, this.allowPrivate);
    } catch (e) {
      if (e instanceof UnsafeUrlError) throw new BadRequestException(e.message);
      throw e;
    }
    const categories = [...new Set(body.categories)].filter((c) => PUSH_CATEGORIES.includes(c));
    const hash = hashOf(body.endpoint);
    await this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      const values = {
        user_id: ctx.userId,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        categories: JSON.stringify(categories),
        lang: body.lang.slice(0, 8),
        user_agent: body.userAgent?.slice(0, 300) ?? null,
      };
      // The same browser again (or after someone else used it): one row, now this person's.
      const done = await tx
        .updateTable('push_subscriptions')
        .set(values)
        .where('endpoint_hash', '=', hash)
        .executeTakeFirst();
      if (!Number(done.numUpdatedRows))
        await tx
          .insertInto('push_subscriptions')
          .values({
            id: randomUUID(),
            tenant_id: ctx.tenantId,
            endpoint_hash: hash,
            created_at: new Date(),
            ...values,
          })
          .execute();
    });
  }

  async unsubscribe(ctx: AuthContext, endpoint: string) {
    await this.engine.sql.withTenant(ctx.tenantId, (tx) =>
      tx
        .deleteFrom('push_subscriptions')
        .where('user_id', '=', ctx.userId)
        .where('endpoint_hash', '=', hashOf(endpoint))
        .execute(),
    );
  }

  /** A notification now, to every browser of the person, whatever categories they chose. */
  async test(ctx: AuthContext) {
    await this.engine.sql.withTenant(ctx.tenantId, (tx) =>
      tx
        .insertInto('push_outbox')
        .values({
          id: randomUUID(),
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          category: 'test',
          payload: JSON.stringify({ url: '/' }),
          next_attempt_at: new Date(),
        })
        .execute(),
    );
    void this.jobs.offer('push.deliver', {}).catch(() => undefined);
  }

  // Delivery

  async deliverDue(): Promise<number> {
    if (!this.enabled) return 0;
    let sent = 0;
    for (const tenantId of await this.engine.sql.tenantsWithPushDue()) {
      try {
        for (;;) {
          const due = await this.engine.sql.withTenant(tenantId, (tx) => this.claim(tx));
          if (!due.length) break;
          for (const d of due) sent += await this.send(tenantId, d);
        }
      } catch (e) {
        this.logger.error(`Push of ${tenantId}: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  private async claim(tx: MssqlTx) {
    const res = await sql<{
      id: string;
      user_id: string;
      category: string;
      payload: string;
      attempt: number;
    }>`
      UPDATE TOP (${BATCH}) dbo.push_outbox
      SET claimed_until = DATEADD(millisecond, ${CLAIM_MS}, SYSDATETIMEOFFSET()), attempt = attempt + 1
      OUTPUT inserted.id, inserted.user_id, inserted.category, inserted.payload, inserted.attempt
      WHERE status = 'pending' AND next_attempt_at <= SYSDATETIMEOFFSET()
        AND (claimed_until IS NULL OR claimed_until < SYSDATETIMEOFFSET())`.execute(tx);
    return res.rows;
  }

  /** Sends one notification to the person's browsers; returns how many were accepted. */
  private async send(
    tenantId: string,
    d: { id: string; user_id: string; category: string; payload: string; attempt: number },
  ): Promise<number> {
    const data = JSON.parse(d.payload) as { count?: number; url: string };
    const subs = await this.engine.sql.withTenant(tenantId, (tx) =>
      tx
        .selectFrom('push_subscriptions')
        .select(['id', 'endpoint', 'p256dh', 'auth', 'categories', 'lang'])
        .where('user_id', '=', d.user_id)
        .where(
          sql<boolean>`EXISTS (SELECT 1 FROM dbo.tenant_members m WHERE m.tenant_id = push_subscriptions.tenant_id AND m.user_id = push_subscriptions.user_id AND m.status = 'active')`,
        )
        .execute(),
    );
    const wanted = subs.filter(
      (s) => d.category === 'test' || (JSON.parse(s.categories) as string[]).includes(d.category),
    );
    let ok = 0;
    let retry = false;
    let lastError: string | null = null;
    const gone: string[] = [];
    for (const s of wanted) {
      try {
        const message = messageFor(d.category as PushCategory, data, s.lang);
        const body = encryptPayload(s, Buffer.from(JSON.stringify(message)));
        const target = await resolveTarget(s.endpoint, this.allowPrivate);
        const status = await post(target, body, {
          'content-type': 'application/octet-stream',
          'content-encoding': 'aes128gcm',
          ttl: String(TTL_SECONDS),
          urgency: 'normal',
          authorization: await vapidAuthorization(s.endpoint, {
            publicKey: this.config.VAPID_PUBLIC_KEY!,
            privateKey: this.config.VAPID_PRIVATE_KEY!,
            subject: this.config.VAPID_SUBJECT!,
          }),
        });
        if (status >= 200 && status < 300) ok++;
        // The browser has forgotten this subscription: it is dropped for good.
        else if (status === 404 || status === 410) gone.push(s.id);
        else if (status === 429 || status >= 500) {
          retry = true;
          lastError = `HTTP ${status}`;
        } else lastError = `HTTP ${status}`;
      } catch (e) {
        retry = true;
        lastError = (e as Error).message.slice(0, 480);
      }
    }
    await this.engine.sql.withTenant(tenantId, async (tx) => {
      if (gone.length) await tx.deleteFrom('push_subscriptions').where('id', 'in', gone).execute();
      const next = PUSH_RETRY_MINUTES[d.attempt - 1];
      const again = retry && ok === 0 && next !== undefined;
      await tx
        .updateTable('push_outbox')
        .set({
          status: again
            ? 'pending'
            : ok > 0 || !wanted.length || !lastError
              ? 'delivered'
              : 'failed',
          claimed_until: null,
          last_error: ok > 0 ? null : lastError,
          ...(again ? { next_attempt_at: new Date(Date.now() + next * 60_000) } : {}),
        })
        .where('id', '=', d.id)
        .execute();
      if (ok)
        await tx
          .updateTable('push_subscriptions')
          .set({ last_ok_at: new Date() })
          .where('user_id', '=', d.user_id)
          .execute();
    });
    return ok;
  }

  // Callbacks about to be due

  /** Every minute: each person with callbacks due in the next five minutes is told once. */
  async callbacksDue(now = new Date()): Promise<number> {
    if (!this.enabled) return 0;
    let n = 0;
    const until = new Date(now.getTime() + CALLBACK_AHEAD_MS);
    // One notification per person and five-minute window, however many callbacks it covers.
    const window = Math.floor(now.getTime() / CALLBACK_AHEAD_MS);
    for (const tenantId of await this.engine.allTenantIds()) {
      try {
        n += await this.engine.sql.withTenant(tenantId, async (tx) => {
          const rows = await sql<{ user_id: string; n: number }>`
            SELECT callback_user_id AS user_id, COUNT(*) AS n FROM dbo.cases
            WHERE callback_user_id IS NOT NULL AND next_contact_at IS NOT NULL
              AND next_contact_at <= ${until.toISOString()}
              AND next_contact_at > ${new Date(now.getTime() - CALLBACK_AHEAD_MS).toISOString()}
              AND status NOT IN ('finalised', 'closed', 'expired')
            GROUP BY callback_user_id`.execute(tx);
          let m = 0;
          for (const r of rows.rows)
            if (
              await enqueuePush(
                tx,
                tenantId,
                r.user_id.toLowerCase(),
                'callbacks',
                { count: r.n, url: '/' },
                `cb:${r.user_id.toLowerCase()}:${window}`,
              )
            )
              m++;
          return m;
        });
      } catch (e) {
        this.logger.error(`Callback notices of ${tenantId}: ${(e as Error).message}`);
      }
    }
    return n;
  }
}
