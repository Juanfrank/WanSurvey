import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { decryptField, encryptField } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { JobsService } from '../jobs/jobs.service.js';
import { WEBHOOK_EVENTS, type WebhookEvent } from './outbox.js';
import { newSecret, signedHeaders } from './signing.js';
import { resolveTarget, UnsafeUrlError } from './url-guard.js';

/** Waits before each new try: 1 min, 5 min, 30 min, 2 h, 12 h, 24 h; then the delivery fails. */
export const RETRY_MINUTES = [1, 5, 30, 120, 720, 1440];
/** Deliveries that fail in a row before the endpoint is switched off. */
export const DISABLE_AFTER = 10;
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE = 4096;
const BATCH = 20;
const CLAIM_MS = 60_000;
/** The old secret keeps signing for this long after a rotation. */
const ROTATION_MS = 24 * 3_600_000;

export interface EndpointBody {
  url: string;
  events: WebhookEvent[];
  projectId: string | null;
}

interface Due {
  id: string;
  endpoint_id: string;
  event_id: string;
  event: string;
  payload: string;
  attempt: number;
}

/**
 * Outgoing webhooks (ADR 0001, decision 3, phase B): the endpoints of an organisation, and the
 * dispatcher that delivers what the outbox holds. Deliveries are rows claimed like the jobs, so
 * they work without Redis and a restart loses none; the address is checked and resolved
 * before every call, no redirect is followed, and the answer read is capped.
 */
@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly engine: Engine,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.jobs.register('webhooks.deliver', () => this.deliverDue());
    this.jobs.schedule('webhooks.deliver', { everyMs: 15_000 });
  }

  private get allowPrivate() {
    return this.config.WEBHOOK_ALLOW_PRIVATE_URLS === 'true';
  }

  private key() {
    return this.config.ENCRYPTION_KEY;
  }

  // Administration

  async list(ctx: AuthContext) {
    return this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('webhook_endpoints')
        .selectAll()
        .orderBy('created_at')
        .execute();
      const counts = await sql<{ endpoint_id: string; status: string; n: number }>`
        SELECT endpoint_id, status, COUNT(*) AS n FROM webhook_deliveries
        WHERE created_at > DATEADD(day, -7, SYSDATETIMEOFFSET()) GROUP BY endpoint_id, status`.execute(
        tx,
      );
      return rows.map((e) => {
        const mine = counts.rows.filter((c) => c.endpoint_id.toLowerCase() === e.id.toLowerCase());
        return {
          id: e.id.toLowerCase(),
          url: e.url,
          events: JSON.parse(e.events) as string[],
          projectId: e.project_id ? e.project_id.toLowerCase() : null,
          enabled: !!e.enabled,
          disabledReason: e.disabled_reason,
          failureStreak: e.failure_streak,
          createdAt: new Date(e.created_at as never),
          lastWeek: Object.fromEntries(mine.map((c) => [c.status, c.n])),
        };
      });
    });
  }

  private async checkBody(body: EndpointBody) {
    try {
      await resolveTarget(body.url, this.allowPrivate);
    } catch (e) {
      if (e instanceof UnsafeUrlError) throw new BadRequestException(e.message);
      throw e;
    }
    for (const ev of body.events)
      if (!(WEBHOOK_EVENTS as readonly string[]).includes(ev))
        throw new BadRequestException(`Unknown event ${ev}`);
  }

  /** Creates an endpoint; its secret is in the answer of this call only. */
  async create(ctx: AuthContext, body: EndpointBody) {
    await this.checkBody(body);
    const id = randomUUID();
    const secret = newSecret();
    await this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      if (body.projectId) {
        const p = await tx
          .selectFrom('projects')
          .select('id')
          .where('id', '=', body.projectId)
          .executeTakeFirst();
        if (!p) throw new NotFoundException('Project not found');
      }
      await tx
        .insertInto('webhook_endpoints')
        .values({
          id,
          tenant_id: ctx.tenantId,
          project_id: body.projectId,
          url: body.url,
          events: JSON.stringify(body.events),
          secret_enc: encryptField(secret, this.key()),
          created_by: ctx.userId,
        })
        .execute();
      await this.audit.recordIn(tx, ctx, {
        action: 'webhook.created',
        targetType: 'webhook',
        targetId: id,
        details: { url: body.url, events: body.events, projectId: body.projectId },
      });
    });
    return { id, secret };
  }

  async update(
    ctx: AuthContext,
    id: string,
    patch: { enabled?: boolean; events?: WebhookEvent[]; url?: string },
  ) {
    if (patch.url || patch.events)
      await this.checkBody({
        url: patch.url ?? 'https://example.org',
        events: patch.events ?? [],
        projectId: null,
      });
    await this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      const set: Record<string, unknown> = {};
      if (patch.url) set.url = patch.url;
      if (patch.events) set.events = JSON.stringify(patch.events);
      if (patch.enabled !== undefined) {
        set.enabled = patch.enabled;
        // Switching it on again clears what switched it off.
        if (patch.enabled) Object.assign(set, { failure_streak: 0, disabled_reason: null });
      }
      if (!Object.keys(set).length) return;
      const done = await tx
        .updateTable('webhook_endpoints')
        .set(set)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!Number(done.numUpdatedRows)) throw new NotFoundException('Webhook not found');
      await this.audit.recordIn(tx, ctx, {
        action: 'webhook.updated',
        targetType: 'webhook',
        targetId: id,
        details: { ...patch },
      });
    });
  }

  async remove(ctx: AuthContext, id: string) {
    await this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      const done = await tx.deleteFrom('webhook_endpoints').where('id', '=', id).executeTakeFirst();
      if (!Number(done.numDeletedRows)) throw new NotFoundException('Webhook not found');
      await this.audit.recordIn(tx, ctx, {
        action: 'webhook.deleted',
        targetType: 'webhook',
        targetId: id,
      });
    });
  }

  /** A new secret; the old one keeps signing for a day so the receiver can change over. */
  async rotate(ctx: AuthContext, id: string) {
    const secret = newSecret();
    await this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      const e = await tx
        .selectFrom('webhook_endpoints')
        .select('secret_enc')
        .where('id', '=', id)
        .executeTakeFirst();
      if (!e) throw new NotFoundException('Webhook not found');
      await tx
        .updateTable('webhook_endpoints')
        .set({
          secret_enc: encryptField(secret, this.key()),
          previous_secret_enc: e.secret_enc,
          previous_secret_until: new Date(Date.now() + ROTATION_MS),
        })
        .where('id', '=', id)
        .execute();
      await this.audit.recordIn(tx, ctx, {
        action: 'webhook.rotated',
        targetType: 'webhook',
        targetId: id,
      });
    });
    return { secret };
  }

  async deliveries(ctx: AuthContext, id: string) {
    const rows = await this.engine.sql.withTenant(ctx.tenantId, (tx) =>
      tx
        .selectFrom('webhook_deliveries')
        .select([
          'id',
          'event',
          'status',
          'attempt',
          'next_attempt_at',
          'last_status_code',
          'last_error',
          'duration_ms',
          'created_at',
          'delivered_at',
        ])
        .where('endpoint_id', '=', id)
        .orderBy('created_at', 'desc')
        .top(100)
        .execute(),
    );
    return rows.map((r) => ({
      id: r.id.toLowerCase(),
      event: r.event,
      status: r.status,
      attempt: r.attempt,
      nextAttemptAt: new Date(r.next_attempt_at as never),
      statusCode: r.last_status_code,
      error: r.last_error,
      durationMs: r.duration_ms,
      createdAt: new Date(r.created_at as never),
      deliveredAt: r.delivered_at ? new Date(r.delivered_at as never) : null,
    }));
  }

  /** Sends the delivery again, now, whatever became of it. */
  async redeliver(ctx: AuthContext, deliveryId: string) {
    await this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      const done = await tx
        .updateTable('webhook_deliveries')
        .set({
          status: 'pending',
          attempt: 0,
          next_attempt_at: new Date(),
          claimed_until: null,
        })
        .where('id', '=', deliveryId)
        .executeTakeFirst();
      if (!Number(done.numUpdatedRows)) throw new NotFoundException('Delivery not found');
    });
    void this.dispatchSoon();
  }

  /** A ping, to see that the endpoint answers and the signature checks out. */
  async test(ctx: AuthContext, id: string) {
    await this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      const e = await tx
        .selectFrom('webhook_endpoints')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (!e) throw new NotFoundException('Webhook not found');
      const eventId = randomUUID();
      await tx
        .insertInto('webhook_deliveries')
        .values({
          id: randomUUID(),
          tenant_id: ctx.tenantId,
          endpoint_id: id,
          event_id: eventId,
          event: 'ping',
          payload: JSON.stringify({
            id: `evt_${eventId}`,
            type: 'ping',
            createdAt: new Date().toISOString(),
            data: {},
          }),
        })
        .execute();
    });
    void this.dispatchSoon();
  }

  private dispatchSoon() {
    return this.jobs.offer('webhooks.deliver', {}).catch(() => undefined);
  }

  // Delivery

  /** Delivers what is due in every organisation that has something due. */
  async deliverDue(): Promise<number> {
    let sent = 0;
    for (const tenantId of await this.engine.sql.tenantsWithWebhooksDue()) {
      try {
        for (;;) {
          const due = await this.engine.sql.withTenant(tenantId, (tx) => this.claim(tx));
          if (!due.length) break;
          const results = await Promise.all(due.map((d) => this.attempt(tenantId, d)));
          sent += results.length;
        }
      } catch (e) {
        this.logger.error(`Webhooks of ${tenantId}: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  private async claim(tx: MssqlTx): Promise<Due[]> {
    const res = await sql<Due>`
      UPDATE TOP (${BATCH}) webhook_deliveries
      SET claimed_until = DATEADD(millisecond, ${CLAIM_MS}, SYSDATETIMEOFFSET()), attempt = attempt + 1
      OUTPUT inserted.id, inserted.endpoint_id, inserted.event_id, inserted.event, inserted.payload, inserted.attempt
      WHERE status = 'pending' AND next_attempt_at <= SYSDATETIMEOFFSET()
        AND (claimed_until IS NULL OR claimed_until < SYSDATETIMEOFFSET())`.execute(tx);
    return res.rows;
  }

  private async attempt(tenantId: string, d: Due): Promise<void> {
    const started = Date.now();
    let code: number | null = null;
    let error: string | null = null;
    try {
      const target = await this.engine.sql.withTenant(tenantId, async (tx) => {
        const e = await tx
          .selectFrom('webhook_endpoints')
          .select(['url', 'enabled', 'secret_enc', 'previous_secret_enc', 'previous_secret_until'])
          .where('id', '=', d.endpoint_id)
          .executeTakeFirst();
        return e;
      });
      if (!target) throw new Error('The endpoint no longer exists');
      const secrets = [decryptField(target.secret_enc, this.key())];
      if (
        target.previous_secret_enc &&
        target.previous_secret_until &&
        new Date(target.previous_secret_until as never) > new Date()
      )
        secrets.push(decryptField(target.previous_secret_enc, this.key()));
      const resolved = await resolveTarget(target.url, this.allowPrivate);
      const ts = Math.floor(Date.now() / 1000);
      const headers = signedHeaders(secrets, `msg_${d.event_id}`, ts, d.payload);
      code = await post(resolved, d.payload, headers);
    } catch (e) {
      error = ((e as Error).message || 'Failed').slice(0, 480);
    }
    const ok = code !== null && code >= 200 && code < 300;
    if (code !== null && !ok) error = `HTTP ${code}`;
    await this.finish(tenantId, d, ok, code, error, Date.now() - started);
  }

  private async finish(
    tenantId: string,
    d: Due,
    ok: boolean,
    code: number | null,
    error: string | null,
    ms: number,
  ) {
    await this.engine.sql.withTenant(tenantId, async (tx) => {
      const retryIn = RETRY_MINUTES[d.attempt - 1];
      const status = ok ? 'delivered' : retryIn === undefined ? 'failed' : 'pending';
      await tx
        .updateTable('webhook_deliveries')
        .set({
          status,
          last_status_code: code,
          last_error: ok ? null : error,
          duration_ms: ms,
          claimed_until: null,
          delivered_at: ok ? new Date() : null,
          ...(status === 'pending'
            ? { next_attempt_at: new Date(Date.now() + retryIn! * 60_000) }
            : {}),
        })
        .where('id', '=', d.id)
        .execute();
      if (ok) {
        await tx
          .updateTable('webhook_endpoints')
          .set({ failure_streak: 0 })
          .where('id', '=', d.endpoint_id)
          .execute();
        return;
      }
      // A delivery that gives up counts against the endpoint; a run of them switches it off.
      if (status !== 'failed') return;
      const e = await tx
        .updateTable('webhook_endpoints')
        .set({ failure_streak: sql<number>`failure_streak + 1` })
        .where('id', '=', d.endpoint_id)
        .output('inserted.failure_streak')
        .executeTakeFirst();
      if (e && e.failure_streak >= DISABLE_AFTER) {
        await tx
          .updateTable('webhook_endpoints')
          .set({ enabled: false, disabled_reason: `${DISABLE_AFTER} deliveries failed in a row` })
          .where('id', '=', d.endpoint_id)
          .where('enabled', '=', true)
          .execute();
        await sql`INSERT INTO audit_log (id, tenant_id, action, target_type, target_id, details)
          VALUES (NEWID(), ${tenantId}, 'webhook.disabled', 'webhook', ${d.endpoint_id},
                  ${JSON.stringify({ reason: 'failures' })})`.execute(tx);
      }
    });
  }
}

/** One POST to the address already checked: no redirect followed, a time limit, a capped read. */
export function post(
  target: { url: URL; address: string; family: 4 | 6 },
  body: string | Buffer,
  headers: Record<string, string>,
): Promise<number> {
  const { url, address, family } = target;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        host: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'WanSurvey-Webhooks/1',
          ...headers,
        },
        // Connect to the address that was checked, not to whatever the name says now.
        lookup: (
          _host: string,
          opts: { all?: boolean },
          cb: (
            e: Error | null,
            a: string | { address: string; family: number }[],
            f?: number,
          ) => void,
        ) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
        servername: url.hostname,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let read = 0;
        res.on('data', (c: Buffer) => {
          read += c.length;
          if (read > MAX_RESPONSE) res.destroy();
        });
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('close', () => resolve(res.statusCode ?? 0));
        res.on('error', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end(body);
  });
}
