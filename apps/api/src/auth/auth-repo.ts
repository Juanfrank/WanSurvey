import { Injectable } from '@nestjs/common';
import { roleMatrix, type Role } from '@wansurvey/schema';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { AuditService, type AuditEntry } from '../audit/audit.service.js';
import { AuditStore } from '../audit/audit-store.mssql.js';
import type { AuthContext } from '../common/auth-context.js';
import {
  columnsAs,
  Database,
  Prepared,
  type AuthUserRow,
  type Tx,
  type UserTenant,
} from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { memberships, sessions, tenantMembers, tenants, users } from '../db/schema.js';
import { IdentityStore } from './identity-store.mssql.js';
import { SessionsStore } from './sessions-store.mssql.js';

/**
 * What sign-in and the session guard need from the database, whichever engine runs: the business
 * rules stay in `AuthService` and `AuthGuard`, written once; this is the part that differs. The
 * PostgreSQL side is the Drizzle code they had; the SQL Server side uses the stores. Until
 * PostgreSQL is retired both exist, and the same HTTP tests run on each (docs/roadmap.md).
 */
export interface NewSession {
  tenantId: string;
  userId: string;
  tokenHash: string;
  csrfToken: string;
  mfaState: string;
  mfaMethod: string | null;
  authMethod: string;
  idpTenant: string | null;
  ip: string | null;
  userAgent: string | null;
  expiresAt: Date;
}

export interface Account {
  email: string;
  name: string;
  firstName: string | null;
  languages: string[];
  totpEnabled: boolean;
  idCode: string | null;
  phoneExtension: string | null;
}

/** A session found by its cookie, with what the guard decides on. */
export interface LoadedSession {
  id: string;
  userId: string;
  csrfToken: string;
  mfaState: string;
  mfaMethod: string | null;
  authMethod: string;
  idpTenant: string | null;
  expiresAt: Date;
  lastSeenAt: Date;
  email: string;
  userStatus: string;
  memberStatus: string;
  rolePermissions: unknown;
  grants: { role: string; projectId: string | null }[];
}

/** One organisation's transaction (and, when given, the acting person's). */
export interface AuthTx {
  roles(userId: string): Promise<string[]>;
  account(userId: string): Promise<Account | null>;
  /** Opens a session; the person's last organisation is set when it differs. */
  openSession(v: NewSession, lastTenantId: string | null): Promise<void>;
  revokeSession(id: string): Promise<void>;
  setMfa(id: string, state: string, method: string | null): Promise<void>;
  /**
   * Checks a second-factor code against the account's secret. `check` gets the encrypted secret and
   * the last step used, and returns the step the code is for (or null). True when the code was
   * valid and had not been used: each code works once, also when two are tried at the same time.
   */
  acceptTotp(
    userId: string,
    check: (secretEnc: string, lastStep: number | null) => number | null,
  ): Promise<boolean>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface AuthRepo {
  // Before any organisation is known.
  userByEmail(email: string): Promise<AuthUserRow | null>;
  lockedUntil(userId: string): Promise<Date | null>;
  failed(userId: string, max: number, lockSeconds: number): Promise<Date | null>;
  succeeded(userId: string): Promise<void>;
  userTenants(userId: string, includeInactive?: boolean): Promise<UserTenant[]>;
  /** Name and e-mail of an account, for what is sent to its owner. */
  contactOf(userId: string): Promise<{ email: string; name: string } | null>;
  /** Works in one organisation, as the person when given. */
  inTenant<T>(tenantId: string, fn: (t: AuthTx) => Promise<T>, userId?: string): Promise<T>;
  /**
   * The live session of a cookie, checked and touched: null when there is none, it ended (idle or
   * absolute expiry, account or membership no longer active; the session is then revoked).
   */
  session(
    tenantId: string,
    tokenHash: string,
    now: Date,
    idleMs: number,
    touchMs: number,
  ): Promise<LoadedSession | null>;
}

/** Whether a loaded session is still good; false: revoke it. */
function ended(s: LoadedSession, now: Date, idleMs: number): boolean {
  return (
    s.userStatus !== 'active' ||
    s.memberStatus !== 'active' ||
    s.expiresAt <= now ||
    now.getTime() - s.lastSeenAt.getTime() > idleMs
  );
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

/**
 * Everything a request's session needs, in one statement: the session, the account and its
 * membership here, the person's roles and what each role may do in this organisation. Every
 * signed-in request runs it (devices sync every few seconds), so it is built once.
 */
const sessionByToken = new Prepared<{
  session: typeof sessions.$inferSelect;
  email: string;
  userStatus: string;
  memberStatus: string;
  rolePermissions: unknown;
  grants: { role: string; projectId: string | null }[];
}>(
  () => sql`
    select ${columnsAs(sessions, 's', 'session')}, u.email as "email", u.status as "userStatus",
           m.status as "memberStatus", t.role_permissions,
           coalesce((select json_agg(json_build_object('role', g.role, 'projectId', g.project_id))
                     from memberships g where g.user_id = s.user_id), '[]'::json) as "grants"
    from sessions s
    join users u on u.id = s.user_id
    join tenant_members m on m.user_id = s.user_id
    join tenants t on t.id = s.tenant_id
    where s.token_hash = ${sql.placeholder('hash')} and s.revoked_at is null
    limit 1`,
  {
    session: getTableColumns(sessions),
    email: 'raw',
    userStatus: 'raw',
    memberStatus: 'raw',
    rolePermissions: tenants.rolePermissions,
    grants: 'raw',
  },
);

class PgAuthTx implements AuthTx {
  constructor(
    private readonly tx: Tx,
    private readonly tenantId: string,
    private readonly audits: AuditService,
  ) {}

  async roles(userId: string) {
    return (
      await this.tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(eq(memberships.userId, userId))
    ).map((r) => r.role);
  }

  async account(userId: string): Promise<Account | null> {
    const [u] = await this.tx.select().from(users).where(eq(users.id, userId));
    if (!u) return null;
    const [m] = await this.tx
      .select({ idCode: tenantMembers.idCode, phoneExtension: tenantMembers.phoneExtension })
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, userId));
    return {
      email: u.email,
      name: u.name,
      firstName: u.firstName,
      languages: u.languages,
      totpEnabled: u.totpEnabled,
      idCode: m?.idCode ?? null,
      phoneExtension: m?.phoneExtension ?? null,
    };
  }

  async openSession(v: NewSession, lastTenantId: string | null) {
    await this.tx.insert(sessions).values({
      tenantId: v.tenantId,
      userId: v.userId,
      tokenHash: v.tokenHash,
      csrfToken: v.csrfToken,
      mfaState: v.mfaState,
      mfaMethod: v.mfaMethod,
      authMethod: v.authMethod,
      idpTenant: v.idpTenant,
      ip: v.ip,
      userAgent: v.userAgent,
      expiresAt: v.expiresAt,
    });
    if (lastTenantId !== v.tenantId)
      await this.tx.update(users).set({ lastTenantId: v.tenantId }).where(eq(users.id, v.userId));
  }

  async revokeSession(id: string) {
    await this.tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id));
  }

  async setMfa(id: string, state: string, method: string | null) {
    await this.tx
      .update(sessions)
      .set({ mfaState: state, mfaMethod: method })
      .where(eq(sessions.id, id));
  }

  async acceptTotp(
    userId: string,
    check: (secretEnc: string, lastStep: number | null) => number | null,
  ): Promise<boolean> {
    const [user] = await this.tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      // One check at a time per account, so a code cannot be used twice in parallel.
      .for('update');
    const step = check(user!.totpSecretEnc!, user!.totpLastStep);
    // Each code works once: a code seen (or stolen) after use is refused.
    const valid = step !== null && (user!.totpLastStep ?? -1) < step;
    if (valid) await this.tx.update(users).set({ totpLastStep: step }).where(eq(users.id, userId));
    return valid;
  }

  audit(entry: AuditEntry) {
    return this.audits.record(this.tx, this.tenantId, entry);
  }
}

@Injectable()
export class PgAuthRepo implements AuthRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  userByEmail(email: string) {
    return this.database.authUserByEmail(email);
  }
  lockedUntil(userId: string) {
    return this.database.accountLockedUntil(userId);
  }
  failed(userId: string, max: number, lockSeconds: number) {
    return this.database.accountFailed(userId, max, lockSeconds);
  }
  succeeded(userId: string) {
    return this.database.accountSucceeded(userId);
  }
  userTenants(userId: string, includeInactive = false) {
    return this.database.userTenants(userId, includeInactive);
  }

  async contactOf(userId: string) {
    const [row] = await this.database.withUser(userId, (tx) =>
      tx.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId)),
    );
    return row ?? null;
  }

  inTenant<T>(tenantId: string, fn: (t: AuthTx) => Promise<T>, userId?: string) {
    return this.database.withTenant(
      tenantId,
      (tx) => fn(new PgAuthTx(tx, tenantId, this.audits)),
      userId,
    );
  }

  /** The same lookup inside a transaction someone else opened (the Microsoft sign-in). */
  wrap(tx: Tx, tenantId: string): AuthTx {
    return new PgAuthTx(tx, tenantId, this.audits);
  }

  session(tenantId: string, tokenHash: string, now: Date, idleMs: number, touchMs: number) {
    return this.database.withTenant(tenantId, async (tx) => {
      const [row] = await sessionByToken.run(tx, { hash: tokenHash });
      if (!row) return null;
      const s: LoadedSession = {
        id: row.session.id,
        userId: row.session.userId,
        csrfToken: row.session.csrfToken,
        mfaState: row.session.mfaState,
        mfaMethod: row.session.mfaMethod,
        authMethod: row.session.authMethod,
        idpTenant: row.session.idpTenant,
        expiresAt: row.session.expiresAt,
        lastSeenAt: row.session.lastSeenAt,
        email: row.email,
        userStatus: row.userStatus,
        memberStatus: row.memberStatus,
        rolePermissions: row.rolePermissions,
        grants: row.grants,
      };
      if (ended(s, now, idleMs)) {
        await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, s.id));
        return null;
      }
      if (now.getTime() - s.lastSeenAt.getTime() > touchMs)
        await tx.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, s.id));
      return s;
    });
  }
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

class MssqlAuthTx implements AuthTx {
  constructor(
    private readonly tx: MssqlTx,
    private readonly tenantId: string,
    private readonly stores: {
      sessions: SessionsStore;
      identity: IdentityStore;
      audit: AuditStore;
    },
  ) {}

  async roles(userId: string) {
    return (
      await this.tx.selectFrom('memberships').select('role').where('user_id', '=', userId).execute()
    ).map((r) => r.role);
  }

  async account(userId: string): Promise<Account | null> {
    const r = await this.tx
      .selectFrom('users as u')
      .leftJoin('tenant_members as m', 'm.user_id', 'u.id')
      .select([
        'u.email',
        'u.name',
        'u.first_name',
        'u.languages',
        'u.totp_enabled',
        'm.id_code',
        'm.phone_extension',
      ])
      .where('u.id', '=', userId)
      .executeTakeFirst();
    return r
      ? {
          email: r.email,
          name: r.name,
          firstName: r.first_name,
          languages: JSON.parse(r.languages) as string[],
          totpEnabled: !!r.totp_enabled,
          idCode: r.id_code,
          phoneExtension: r.phone_extension,
        }
      : null;
  }

  async openSession(v: NewSession, lastTenantId: string | null) {
    await this.stores.sessions.open(this.tx, { ...v, lastTenantId });
  }

  revokeSession(id: string) {
    return this.stores.sessions.revoke(this.tx, id);
  }

  setMfa(id: string, state: string, method: string | null) {
    return this.stores.sessions.setMfa(this.tx, id, { state, method });
  }

  async acceptTotp(
    userId: string,
    check: (secretEnc: string, lastStep: number | null) => number | null,
  ): Promise<boolean> {
    const c = await this.stores.identity.credentials(this.tx, userId);
    if (!c?.totpSecretEnc) return false;
    const step = check(c.totpSecretEnc, c.totpLastStep);
    if (step === null) return false;
    // The update moves the last step forward only once, so two codes tried together cannot both pass.
    return this.stores.identity.acceptTotpStep(this.tx, userId, step);
  }

  audit(entry: AuditEntry) {
    return this.stores.audit.record(this.tx, this.tenantId, entry);
  }
}

@Injectable()
export class MssqlAuthRepo implements AuthRepo {
  private readonly stores = {
    sessions: new SessionsStore(),
    identity: new IdentityStore(),
    audit: new AuditStore(),
  };

  constructor(private readonly engine: Engine) {}

  private get db() {
    return this.engine.sql;
  }

  async userByEmail(email: string): Promise<AuthUserRow | null> {
    const r = await this.db.userByEmail(email);
    return r
      ? {
          id: r.id.toLowerCase(),
          passwordHash: r.password_hash,
          status: r.status,
          totpEnabled: !!r.totp_enabled,
          lastTenantId: r.last_tenant_id?.toLowerCase() ?? null,
        }
      : null;
  }
  lockedUntil(userId: string) {
    return this.db.accountLockedUntil(userId);
  }
  failed(userId: string, max: number, lockSeconds: number) {
    return this.db.accountFailed(userId, max, lockSeconds);
  }
  succeeded(userId: string) {
    return this.db.accountSucceeded(userId);
  }
  userTenants(userId: string, includeInactive = false) {
    return this.db.userTenants(userId, includeInactive);
  }

  async contactOf(userId: string) {
    return this.db.withUser(userId, async (tx) => {
      const u = await tx
        .selectFrom('users')
        .select(['email', 'name'])
        .where('id', '=', userId)
        .executeTakeFirst();
      return u ?? null;
    });
  }

  inTenant<T>(tenantId: string, fn: (t: AuthTx) => Promise<T>, userId?: string) {
    return this.db.withTenant(
      tenantId,
      (tx) => fn(new MssqlAuthTx(tx, tenantId, this.stores)),
      userId,
    );
  }

  session(tenantId: string, tokenHash: string, now: Date, idleMs: number, touchMs: number) {
    return this.db.withTenant(tenantId, async (tx) => {
      const row = await this.stores.sessions.byToken(tx, tokenHash);
      if (!row) return null;
      const s: LoadedSession = { ...row };
      if (ended(s, now, idleMs)) {
        await this.stores.sessions.revoke(tx, s.id, now);
        return null;
      }
      if (now.getTime() - s.lastSeenAt.getTime() > touchMs)
        await this.stores.sessions.touch(tx, s.id, now);
      return s;
    });
  }
}

export const AUTH_REPO = Symbol('AUTH_REPO');

/** The grants of a loaded session as the guard turns them into an `AuthContext`. */
export function grantsOf(s: LoadedSession): AuthContext['memberships'] {
  const matrix = roleMatrix(s.rolePermissions as never);
  return (
    s.grants
      // A role this version no longer knows grants nothing.
      .filter((g) => g.role in matrix)
      .map((g) => ({
        role: g.role as Role,
        projectId: g.projectId,
        permissions: matrix[g.role as Role],
      }))
  );
}
