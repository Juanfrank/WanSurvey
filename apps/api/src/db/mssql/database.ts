import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { isUuid } from '../common.js';
import { createMssqlDb, mssqlNumber, type MssqlOptions } from './connection.js';
import type { MssqlSchema } from './schema.js';

export type MssqlTx = Transaction<MssqlSchema>;

/** Lookups by a public key (link token, slug) that find the organisation before any context. */
export type PublicLookup =
  'invitation_by_token' | 'open_link_by_slug' | 'feedback_point_by_slug' | 'share_link_by_hash';
const LOOKUP_PARAM: Record<PublicLookup, string> = {
  invitation_by_token: 'hash',
  open_link_by_slug: 'slug',
  feedback_point_by_slug: 'slug',
  share_link_by_hash: 'hash',
};

/** Deadlock victim: the transaction rolled back entirely, so it can simply run again. */
const DEADLOCK = 1205;
/** The lock wait exceeded LOCK_TIMEOUT. */
const LOCK_TIMEOUT = 1222;
/** ROLLBACK without a transaction: SQL Server had already ended it. */
const NO_TRANSACTION = 3903;
const ATTEMPTS = 3;

export interface MssqlLimits {
  /** How long a statement may wait for a lock (ms); -1: forever. */
  lockTimeoutMs: number;
}

/**
 * `withTenant`: a transaction whose SESSION_CONTEXT
 * carries the organisation, which the security policy (mssql/0001) filters every row by.
 * SESSION_CONTEXT belongs to the connection, not the transaction, and pooled connections are
 * reused: it is set first thing in every transaction and cleared before it ends, so a
 * connection never carries one organisation's context into another's work.
 */
interface SsoRow {
  tenant_id: string;
  slug: string;
  entra_tenant_id: string;
  client_id: string;
  enabled: boolean;
}
const ssoPublic = (r: SsoRow) => ({
  tenantId: r.tenant_id.toLowerCase(),
  slug: r.slug,
  entraTenantId: r.entra_tenant_id,
  clientId: r.client_id,
  enabled: !!r.enabled,
});

/**
 * Whether an organisation may be opened by this process. Single-tenant mode (`Tenancy`) sets one:
 * every other organisation in the database is closed, computed from the configuration at run time
 * and never stored, so turning the mode off opens them all again.
 */
export type TenantFence = (tenantId: string) => Promise<boolean>;

/**
 * A closed organisation (single-tenant mode) was asked for: it answers as something that does not
 * exist, so nothing tells that it is there.
 */
export class TenantClosedError extends NotFoundException {
  constructor() {
    super({ code: 'NOT_FOUND', message: 'Not found' });
    this.name = 'TenantClosedError';
  }
}

export class MssqlDatabase {
  readonly db: Kysely<MssqlSchema>;
  private gate: TenantFence | null = null;

  constructor(url: string, opts: MssqlOptions & Partial<MssqlLimits> = {}, limits?: MssqlLimits) {
    const lockTimeoutMs = limits?.lockTimeoutMs ?? opts.lockTimeoutMs ?? 5_000;
    this.db = createMssqlDb<MssqlSchema>(url, { ...opts, lockTimeoutMs });
  }

  /**
   * Closes every organisation `opens` refuses (single-tenant mode): `withTenant` answers as not
   * found, a public link of one finds nothing, and the lookups and lists that work across
   * organisations (jobs, sign-in, keys, links) leave them out. Null opens every organisation.
   */
  fence(opens: TenantFence | null): void {
    this.gate = opens;
  }

  /** Whether the organisation may be opened here (always, without a fence). */
  async opens(tenantId: string): Promise<boolean> {
    return !this.gate || this.gate(tenantId.toLowerCase());
  }

  /**
   * Only to honour a person's opt-out (an SMS stop word, a hard bounce or complaint reported by the
   * mail provider), which must hold once a closed organisation opens again: the work runs in the
   * organisation whatever the fence. Never for anything that reads or sends.
   */
  async withTenantForOptOut<T>(tenantId: string, fn: (tx: MssqlTx) => Promise<T>): Promise<T> {
    if (!isUuid(tenantId)) throw new Error('Invalid tenant id');
    return this.run(
      async () => tenantId,
      (tx) => fn(tx),
    );
  }

  /**
   * Only for the retention the organisation set for itself (personal data anonymised or sealed,
   * recordings and export files deleted when their period ends): it keeps running while the
   * organisation is closed in single-tenant mode, so being closed never keeps personal data past
   * its period. Never for anything that sends, or answers a request.
   */
  async withTenantForRetention<T>(tenantId: string, fn: (tx: MssqlTx) => Promise<T>): Promise<T> {
    return this.withTenantForOptOut(tenantId, fn);
  }

  /** Every organisation whatever the fence, for the retention jobs only (`withTenantForRetention`). */
  async allTenantIdsForRetention(): Promise<string[]> {
    const res = await sql<{ tenant_id: string }>`EXEC all_tenant_ids`.execute(this.db);
    return res.rows.map((r) => r.tenant_id.toLowerCase());
  }

  /** The items whose organisation may be opened here. */
  private async open<T>(items: T[], tenantOf: (item: T) => string | null): Promise<T[]> {
    if (!this.gate) return items;
    const out: T[] = [];
    for (const item of items) {
      const t = tenantOf(item);
      if (t === null || (await this.opens(t))) out.push(item);
    }
    return out;
  }

  /**
   * `userId`, when given, pins the acting person too (SESSION_CONTEXT 'user_id'), which lets them
   * change their own global account.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: MssqlTx) => Promise<T>,
    userId?: string,
  ): Promise<T> {
    if (!isUuid(tenantId)) throw new Error('Invalid tenant id');
    if (userId !== undefined && !isUuid(userId)) throw new Error('Invalid user id');
    if (!(await this.opens(tenantId))) throw new TenantClosedError();
    return this.run(
      async () => tenantId,
      (tx) => fn(tx),
      userId,
    );
  }

  /** User context only, for account-level changes that belong to no organisation. */
  async withUser<T>(userId: string, fn: (tx: MssqlTx) => Promise<T>): Promise<T> {
    if (!isUuid(userId)) throw new Error('Invalid user id');
    return this.run(
      async () => null,
      (tx) => fn(tx),
      userId,
    );
  }

  /**
   * Finds a link's organisation and works in it in one transaction: the lookup (a procedure that
   * runs as the owner) and the context are set before anything else. `fn` gets
   * null when nothing matches (and no context is set then, so it sees nothing).
   */
  async withTenantOf<T>(
    lookup: PublicLookup,
    key: string,
    fn: (tx: MssqlTx, found: { id: string; tenantId: string } | null) => Promise<T>,
  ): Promise<T> {
    let found: { id: string; tenantId: string } | null = null;
    return this.run(
      async (tx) => {
        const res = await sql<{
          id: string;
          tenant_id: string;
        }>`EXEC ${sql.raw(`${lookup}`)} ${sql.raw(`@${LOOKUP_PARAM[lookup]}`)} = ${key}`.execute(
          tx,
        );
        const r = res.rows[0];
        found = r ? { id: r.id.toLowerCase(), tenantId: r.tenant_id.toLowerCase() } : null;
        // A closed organisation's link is no link at all (the same answer as an unknown one).
        if (found && !(await this.opens(found.tenantId))) found = null;
        return found?.tenantId ?? null;
      },
      (tx) => fn(tx, found),
    );
  }

  /** The shared transaction: limits, then the context `prepare` decides, cleared at the end. */
  private async run<T>(
    prepare: (tx: MssqlTx) => Promise<string | null>,
    fn: (tx: MssqlTx) => Promise<T>,
    userId?: string,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      // SQL Server ends the transaction itself on a deadlock or an error thrown by a trigger;
      // Kysely's own rollback then fails ("no corresponding BEGIN TRANSACTION") and hides the
      // real error. Keep the first error and report it.
      let original: unknown;
      try {
        return await this.db.transaction().execute(async (tx) => {
          const tenantId = await prepare(tx);
          if (tenantId)
            await sql`EXEC sp_set_session_context @key = N'tenant_id', @value = ${tenantId}`.execute(
              tx,
            );
          if (userId)
            await sql`EXEC sp_set_session_context @key = N'user_id', @value = ${userId}`.execute(
              tx,
            );
          try {
            return await fn(tx);
          } catch (e) {
            original = e;
            throw e;
          } finally {
            // Before the commit or rollback, on the same connection.
            await sql`EXEC sp_set_session_context @key = N'tenant_id', @value = NULL`
              .execute(tx)
              .catch(() => undefined);
            if (userId)
              await sql`EXEC sp_set_session_context @key = N'user_id', @value = NULL`
                .execute(tx)
                .catch(() => undefined);
          }
        });
      } catch (caught) {
        const e =
          original !== undefined && mssqlNumber(caught) === NO_TRANSACTION ? original : caught;
        const n = mssqlNumber(e);
        if (n === DEADLOCK && attempt < ATTEMPTS) {
          await new Promise((ok) => setTimeout(ok, 20 * attempt + Math.random() * 50));
          continue;
        }
        if (n === LOCK_TIMEOUT)
          throw new ServiceUnavailableException({
            code: 'BUSY',
            message: 'The server is busy; please try again in a moment',
          });
        throw e;
      }
    }
  }

  /** An organisation's id by slug, before any session (a procedure that runs as the owner). */
  async tenantIdBySlug(slug: string): Promise<string | null> {
    const res = await sql<{ id: string }>`EXEC tenant_id_by_slug @slug = ${slug}`.execute(this.db);
    const id = res.rows[0]?.id.toLowerCase() ?? null;
    return id && (await this.opens(id)) ? id : null;
  }

  // Sign-in lookups run before any organisation or person is known, through owner procedures.

  async userByEmail(email: string): Promise<{
    id: string;
    password_hash: string | null;
    status: string;
    totp_enabled: boolean;
    last_tenant_id: string | null;
  } | null> {
    const res = await sql<{
      id: string;
      password_hash: string | null;
      status: string;
      totp_enabled: boolean;
      last_tenant_id: string | null;
    }>`EXEC auth_user_by_email @email = ${email}`.execute(this.db);
    return res.rows[0] ?? null;
  }

  /** The organisation and id of a live share link, from the hash of its token. */
  async shareLinkByHash(hash: string): Promise<{ id: string; tenantId: string } | null> {
    const res = await sql<{ id: string; tenant_id: string }>`
      EXEC share_link_by_hash @hash = ${hash}`.execute(this.db);
    const r = res.rows[0];
    if (!r || !(await this.opens(r.tenant_id))) return null;
    return { id: r.id.toLowerCase(), tenantId: r.tenant_id.toLowerCase() };
  }

  /** The organisation of an invitation (a mail provider's event carries only its id). */
  async invitationTenant(id: string, opts: { evenClosed?: boolean } = {}): Promise<string | null> {
    if (!isUuid(id)) return null;
    const res = await sql<{ tenant_id: string }>`
      EXEC invitation_tenant @id = ${id}`.execute(this.db);
    const t = res.rows[0]?.tenant_id.toLowerCase() ?? null;
    return t && (opts.evenClosed || (await this.opens(t))) ? t : null;
  }

  /** The organisations with invitations or reminders to send. */
  async tenantsWithMailDue(): Promise<string[]> {
    const res = await sql<{ tenant_id: string }>`EXEC tenants_with_mail_due`.execute(this.db);
    return this.open(
      res.rows.map((r) => r.tenant_id.toLowerCase()),
      (t) => t,
    );
  }

  /** The organisations with web notifications due. */
  async tenantsWithPushDue(): Promise<string[]> {
    const res = await sql<{ tenant_id: string }>`EXEC tenants_with_push_due`.execute(this.db);
    return this.open(
      res.rows.map((r) => r.tenant_id.toLowerCase()),
      (t) => t,
    );
  }

  /** The organisations that invited this address (an SMS reply carries only the number). */
  async tenantsInvitedAt(address: string, opts: { evenClosed?: boolean } = {}): Promise<string[]> {
    const res = await sql<{ tenant_id: string }>`
      EXEC tenants_invited_at @address = ${address}`.execute(this.db);
    const all = res.rows.map((r) => r.tenant_id.toLowerCase());
    return opts.evenClosed ? all : this.open(all, (t) => t);
  }

  /** The organisations with webhook deliveries due. */
  async tenantsWithWebhooksDue(): Promise<string[]> {
    const res = await sql<{ tenant_id: string }>`EXEC tenants_with_webhooks_due`.execute(this.db);
    return this.open(
      res.rows.map((r) => r.tenant_id.toLowerCase()),
      (t) => t,
    );
  }

  /** Every organisation, for nightly jobs. */
  async allTenantIds(): Promise<string[]> {
    const res = await sql<{ tenant_id: string }>`EXEC all_tenant_ids`.execute(this.db);
    return this.open(
      res.rows.map((r) => r.tenant_id.toLowerCase()),
      (t) => t,
    );
  }

  /**
   * Every organisation with its slug and creation time, oldest first, whatever the fence: how
   * single-tenant mode chooses the one it serves. A row is read in the organisation's own context
   * (row-level security), as nothing else may read `tenants` across organisations.
   */
  async everyTenant(): Promise<{ id: string; slug: string; createdAt: Date }[]> {
    const res = await sql<{ tenant_id: string }>`EXEC all_tenant_ids`.execute(this.db);
    const out: { id: string; slug: string; createdAt: Date }[] = [];
    for (const { tenant_id } of res.rows) {
      const id = tenant_id.toLowerCase();
      const row = await this.run(
        async () => id,
        (tx) =>
          tx
            .selectFrom('tenants')
            .select(['slug', 'created_at'])
            .where('id', '=', id)
            .executeTakeFirst(),
      );
      if (row) out.push({ id, slug: row.slug, createdAt: new Date(row.created_at) });
    }
    return out.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
    );
  }

  /** The account an external identity is linked to, in any organisation. */
  async userByIdentity(issuer: string, subject: string): Promise<string | null> {
    const res = await sql<{ user_id: string }>`
      EXEC user_by_identity @issuer = ${issuer}, @subject = ${subject}`.execute(this.db);
    return res.rows[0]?.user_id.toLowerCase() ?? null;
  }

  /** Who a live one-time token belongs to (the link carries only the token). */
  async peekUserToken(
    tokenHash: string,
    purpose: string,
  ): Promise<{ user_id: string; tenant_id: string | null } | null> {
    const res = await sql<{ user_id: string; tenant_id: string | null }>`
      EXEC peek_user_token @token_hash = ${tokenHash}, @purpose = ${purpose}`.execute(this.db);
    const r = res.rows[0];
    // A token for a closed organisation (an invitation to it) is no token here.
    if (!r || (r.tenant_id && !(await this.opens(r.tenant_id)))) return null;
    return r;
  }

  /** The key a request presents, before any organisation is known (the caller checks it). */
  async apiKeyLookup(keyId: string) {
    const res = await sql<{
      id: string;
      tenant_id: string;
      secret_hash: string;
      scopes: string;
      project_id: string | null;
      allowed_ips: string | null;
      expires_at: Date;
      created_by: string;
      revoked_at: Date | null;
    }>`EXEC api_key_lookup @key_id = ${keyId}`.execute(this.db);
    const r = res.rows[0];
    return r && (await this.opens(r.tenant_id)) ? r : null;
  }

  /** Until when the account is locked after failed attempts; null when it is not. */
  async accountLockedUntil(userId: string): Promise<Date | null> {
    const res = await sql<{ until: Date | null }>`
      EXEC account_locked_until @user_id = ${userId}`.execute(this.db);
    return res.rows[0]?.until ? new Date(res.rows[0].until) : null;
  }

  /** Counts a failed password or code; returns the end of the lock it caused, if any. */
  async accountFailed(userId: string, max: number, lockSeconds: number): Promise<Date | null> {
    const res = await sql<{ until: Date | null }>`
      EXEC account_failed @user_id = ${userId}, @max = ${max}, @lock_seconds = ${lockSeconds}`.execute(
      this.db,
    );
    return res.rows[0]?.until ? new Date(res.rows[0].until) : null;
  }

  async accountSucceeded(userId: string): Promise<void> {
    await sql`EXEC account_succeeded @user_id = ${userId}`.execute(this.db);
  }

  /** Organisations the person is an active member of (or every membership). */
  /**
   * `evenClosed`: closed organisations too, for the security checks that ask where an account
   * belongs (linking a Microsoft identity), never for what opens an organisation.
   */
  async userTenants(
    userId: string,
    includeInactive = false,
    evenClosed = false,
  ): Promise<{ id: string; slug: string; name: string; memberStatus: string }[]> {
    const res = await sql<{ id: string; slug: string; name: string; member_status: string }>`
      EXEC user_tenants @user_id = ${userId}, @include_inactive = ${includeInactive ? 1 : 0}`.execute(
      this.db,
    );
    const all = res.rows.map((r) => ({
      id: r.id.toLowerCase(),
      slug: r.slug,
      name: r.name,
      memberStatus: r.member_status,
    }));
    return evenClosed ? all : this.open(all, (t) => t.id);
  }

  /** Which of the organisations require Microsoft sign-in, and through which directory. */
  async ssoEnforcedTenants(
    tenantIds: string[],
  ): Promise<{ tenantId: string; entraTenantId: string }[]> {
    if (tenantIds.length === 0) return [];
    const res = await sql<{ tenant_id: string; entra_tenant_id: string }>`
      EXEC sso_enforced_tenants @tenant_ids = ${JSON.stringify(tenantIds)}`.execute(this.db);
    return this.open(
      res.rows.map((r) => ({
        tenantId: r.tenant_id.toLowerCase(),
        entraTenantId: r.entra_tenant_id,
      })),
      (t) => t.tenantId,
    );
  }

  /** Public Microsoft settings of an organisation by slug (never the secret). */
  async ssoConfigBySlug(slug: string) {
    const res = await sql<SsoRow>`EXEC sso_config_by_slug @slug = ${slug}`.execute(this.db);
    const r = res.rows[0] ? ssoPublic(res.rows[0]) : null;
    return r && (await this.opens(r.tenantId)) ? r : null;
  }

  async ssoTenantsForDomain(domain: string) {
    const res = await sql<SsoRow>`EXEC sso_tenants_for_domain @domain = ${domain}`.execute(this.db);
    return this.open(res.rows.map(ssoPublic), (t) => t.tenantId);
  }

  /** Whether the database answers. */
  async probe(): Promise<boolean> {
    try {
      await sql`SELECT 1 AS ok`.execute(this.db);
      return true;
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    await this.db.destroy();
  }
}
