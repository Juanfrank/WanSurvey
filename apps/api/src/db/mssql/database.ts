import { ServiceUnavailableException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { isUuid } from '../database.js';
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
 * The SQL Server counterpart of `Database.withTenant`: a transaction whose SESSION_CONTEXT
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

export class MssqlDatabase {
  readonly db: Kysely<MssqlSchema>;

  constructor(
    url: string,
    opts: MssqlOptions & Partial<MssqlLimits> = {},
    private readonly limits: MssqlLimits = { lockTimeoutMs: opts.lockTimeoutMs ?? 5_000 },
  ) {
    this.db = createMssqlDb<MssqlSchema>(url, opts);
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
   * runs as the owner) and the context are set before anything else, as on PostgreSQL. `fn` gets
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
        }>`EXEC ${sql.raw(`dbo.${lookup}`)} ${sql.raw(`@${LOOKUP_PARAM[lookup]}`)} = ${key}`.execute(
          tx,
        );
        const r = res.rows[0];
        found = r ? { id: r.id.toLowerCase(), tenantId: r.tenant_id.toLowerCase() } : null;
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
          await sql`SET LOCK_TIMEOUT ${sql.lit(this.limits.lockTimeoutMs)}`.execute(tx);
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
    const res = await sql<{ id: string }>`EXEC dbo.tenant_id_by_slug @slug = ${slug}`.execute(
      this.db,
    );
    return res.rows[0]?.id.toLowerCase() ?? null;
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
    }>`EXEC dbo.auth_user_by_email @email = ${email}`.execute(this.db);
    return res.rows[0] ?? null;
  }

  /** The account an external identity is linked to, in any organisation. */
  async userByIdentity(issuer: string, subject: string): Promise<string | null> {
    const res = await sql<{ user_id: string }>`
      EXEC dbo.user_by_identity @issuer = ${issuer}, @subject = ${subject}`.execute(this.db);
    return res.rows[0]?.user_id.toLowerCase() ?? null;
  }

  /** Who a live one-time token belongs to (the link carries only the token). */
  async peekUserToken(
    tokenHash: string,
    purpose: string,
  ): Promise<{ user_id: string; tenant_id: string | null } | null> {
    const res = await sql<{ user_id: string; tenant_id: string | null }>`
      EXEC dbo.peek_user_token @token_hash = ${tokenHash}, @purpose = ${purpose}`.execute(this.db);
    return res.rows[0] ?? null;
  }

  /** Until when the account is locked after failed attempts; null when it is not. */
  async accountLockedUntil(userId: string): Promise<Date | null> {
    const res = await sql<{ until: Date | null }>`
      EXEC dbo.account_locked_until @user_id = ${userId}`.execute(this.db);
    return res.rows[0]?.until ? new Date(res.rows[0].until) : null;
  }

  /** Counts a failed password or code; returns the end of the lock it caused, if any. */
  async accountFailed(userId: string, max: number, lockSeconds: number): Promise<Date | null> {
    const res = await sql<{ until: Date | null }>`
      EXEC dbo.account_failed @user_id = ${userId}, @max = ${max}, @lock_seconds = ${lockSeconds}`.execute(
      this.db,
    );
    return res.rows[0]?.until ? new Date(res.rows[0].until) : null;
  }

  async accountSucceeded(userId: string): Promise<void> {
    await sql`EXEC dbo.account_succeeded @user_id = ${userId}`.execute(this.db);
  }

  /** Organisations the person is an active member of (or every membership). */
  async userTenants(
    userId: string,
    includeInactive = false,
  ): Promise<{ id: string; slug: string; name: string; memberStatus: string }[]> {
    const res = await sql<{ id: string; slug: string; name: string; member_status: string }>`
      EXEC dbo.user_tenants @user_id = ${userId}, @include_inactive = ${includeInactive ? 1 : 0}`.execute(
      this.db,
    );
    return res.rows.map((r) => ({
      id: r.id.toLowerCase(),
      slug: r.slug,
      name: r.name,
      memberStatus: r.member_status,
    }));
  }

  /** Which of the organisations require Microsoft sign-in, and through which directory. */
  async ssoEnforcedTenants(
    tenantIds: string[],
  ): Promise<{ tenantId: string; entraTenantId: string }[]> {
    if (tenantIds.length === 0) return [];
    const res = await sql<{ tenant_id: string; entra_tenant_id: string }>`
      EXEC dbo.sso_enforced_tenants @tenant_ids = ${JSON.stringify(tenantIds)}`.execute(this.db);
    return res.rows.map((r) => ({
      tenantId: r.tenant_id.toLowerCase(),
      entraTenantId: r.entra_tenant_id,
    }));
  }

  /** Public Microsoft settings of an organisation by slug (never the secret). */
  async ssoConfigBySlug(slug: string) {
    const res = await sql<SsoRow>`EXEC dbo.sso_config_by_slug @slug = ${slug}`.execute(this.db);
    return res.rows[0] ? ssoPublic(res.rows[0]) : null;
  }

  async ssoTenantsForDomain(domain: string) {
    const res = await sql<SsoRow>`EXEC dbo.sso_tenants_for_domain @domain = ${domain}`.execute(
      this.db,
    );
    return res.rows.map(ssoPublic);
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
