import { Injectable } from '@nestjs/common';
import { roleMatrix, type Role } from '@wansurvey/schema';
import type { AuditEntry } from '../audit/audit.service.js';
import { AuditStore } from '../audit/audit-store.mssql.js';
import { PeopleStore } from '../users/people-store.mssql.js';
import { randomToken, sha256Hex } from '../common/crypto.js';
import type { AuthContext } from '../common/auth-context.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { IdentityStore, type SsoRow, type SsoValues } from './identity-store.mssql.js';
import { SessionsStore } from './sessions-store.mssql.js';
import type { AuthUserRow, UserTenant } from '../db/common.js';

/**
 * What sign-in and the session guard need from the database: the business rules stay in
 * `AuthService` and `AuthGuard`; this is the data access, implemented with the stores.
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

/** What password, second-factor and one-time-token flows read of an account. */
export interface Credentials {
  email: string;
  status: string;
  passwordHash: string | null;
  totpEnabled: boolean;
  totpSecretEnc: string | null;
}

/** A Microsoft identity already linked, with its account and membership here and its roles. */
export interface LinkedAccount {
  userId: string;
  userStatus: string;
  totpEnabled: boolean;
  lastTenantId: string | null;
  memberStatus: string;
  roles: string[];
}

export type { SsoRow, SsoValues };

export type TokenPurpose = 'invitation' | 'password_reset';

/** The person's own account: what needs only them in context, not an organisation. */
export interface AccountTx {
  credentials(userId: string): Promise<Credentials | null>;
  setTotpSecret(userId: string, secretEnc: string): Promise<void>;
  /** Turns the second factor on; `step` is the code that proved it (each code works once). */
  enableTotp(userId: string, step: number): Promise<void>;
  /** A new password; `activate` also takes a pending account to active. */
  setPassword(userId: string, passwordHash: string, activate?: boolean): Promise<void>;
  /** A single-use token; only its hash is stored. Returns the token to send. */
  issueToken(v: {
    tenantId: string | null;
    userId: string;
    purpose: TokenPurpose;
    ttlHours: number;
  }): Promise<string>;
  /** Uses a live token once: true for the one call that gets it, even when two race. */
  useToken(raw: string): Promise<boolean>;
}

/** One organisation's transaction (and, when given, the acting person's). */
export interface AuthTx extends AccountTx {
  /** An invited member accepts: true when there was an invitation to accept. */
  activateMember(userId: string): Promise<boolean>;

  // Microsoft sign-in
  /** The linked identity's account, membership here and roles; null when not linked here. */
  linked(issuer: string, subject: string): Promise<LinkedAccount | null>;
  /** The member status of the account in this organisation; null when it is not a member. */
  memberStatus(userId: string): Promise<string | null>;
  /** A new active account (first Microsoft sign-in). */
  createSsoAccount(v: {
    id: string;
    email: string;
    name: string;
    firstName: string | null;
  }): Promise<void>;
  /** Takes a pending account to active (Microsoft has proven who they are). */
  activateAccount(userId: string): Promise<void>;
  linkIdentity(userId: string, issuer: string, subject: string): Promise<void>;
  /** Adds the account to the organisation, active and without roles. */
  addMember(userId: string): Promise<void>;
  /** E-mail addresses of the people who administer the organisation. */
  adminEmails(): Promise<string[]>;
  /** The account behind a session opened with password and second factor; null when none. */
  passwordSessionUser(tokenHash: string, now: Date): Promise<string | null>;

  // The organisation's Microsoft sign-in settings
  ssoSettings(): Promise<SsoRow | null>;
  /** Takes the lock that serialises changes to the domains (held to the end of the tx). */
  lockSsoDomains(): Promise<void>;
  ssoDomainOwners(domain: string): Promise<string[]>;
  saveSso(v: SsoValues): Promise<SsoRow>;
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
  /** The account an external identity is linked to, in any organisation. */
  identityUser(issuer: string, subject: string): Promise<string | null>;
  /** Who a live token belongs to, without using it (the link carries only the token). */
  peekToken(
    raw: string,
    purpose: TokenPurpose,
  ): Promise<{ userId: string; tenantId: string | null } | null>;
  /** Works on the person's own account, outside any organisation. */
  inUser<T>(userId: string, fn: (t: AccountTx) => Promise<T>): Promise<T>;
  /** Ends the person's live sessions in every organisation. */
  revokeEverywhere(userId: string): Promise<number>;
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

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

class MssqlAuthTx implements AuthTx {
  constructor(
    private readonly tx: MssqlTx,
    private readonly tenantId: string,
    private readonly stores: {
      sessions: SessionsStore;
      identity: IdentityStore;
      audit: AuditStore;
      people: PeopleStore;
    },
  ) {}

  async credentials(userId: string): Promise<Credentials | null> {
    const u = await this.tx
      .selectFrom('users')
      .select(['email', 'status', 'password_hash', 'totp_enabled', 'totp_secret_enc'])
      .where('id', '=', userId)
      .executeTakeFirst();
    return u
      ? {
          email: u.email,
          status: u.status,
          passwordHash: u.password_hash,
          totpEnabled: !!u.totp_enabled,
          totpSecretEnc: u.totp_secret_enc,
        }
      : null;
  }

  setTotpSecret(userId: string, secretEnc: string) {
    return this.stores.people.updateAccount(this.tx, userId, { totpSecretEnc: secretEnc });
  }

  enableTotp(userId: string, step: number) {
    return this.stores.people.updateAccount(this.tx, userId, {
      totpEnabled: true,
      totpLastStep: step,
    });
  }

  setPassword(userId: string, passwordHash: string, activate = false) {
    return this.stores.people.updateAccount(this.tx, userId, {
      passwordHash,
      ...(activate ? { status: 'active' } : {}),
    });
  }

  async issueToken(v: Parameters<AccountTx['issueToken']>[0]) {
    const raw = randomToken();
    await this.stores.sessions.issueToken(this.tx, {
      tenantId: v.tenantId,
      userId: v.userId,
      purpose: v.purpose,
      tokenHash: sha256Hex(raw),
      expiresAt: new Date(Date.now() + v.ttlHours * 3600_000),
    });
    return raw;
  }

  useToken(raw: string) {
    return this.stores.sessions.useToken(this.tx, sha256Hex(raw));
  }

  activateMember(userId: string) {
    return this.stores.people.activateInvited(this.tx, userId);
  }

  async linked(issuer: string, subject: string): Promise<LinkedAccount | null> {
    const userId = await this.stores.identity.userByIdentity(this.tx, issuer, subject);
    if (!userId) return null;
    const u = await this.tx
      .selectFrom('users as u')
      .innerJoin('tenant_members as m', 'm.user_id', 'u.id')
      .select(['u.status', 'u.totp_enabled', 'u.last_tenant_id', 'm.status as member_status'])
      .where('u.id', '=', userId)
      .executeTakeFirst();
    if (!u) return null;
    return {
      userId,
      userStatus: u.status,
      totpEnabled: !!u.totp_enabled,
      lastTenantId: u.last_tenant_id?.toLowerCase() ?? null,
      memberStatus: u.member_status,
      roles: await this.roles(userId),
    };
  }

  async memberStatus(userId: string) {
    return (await this.stores.people.member(this.tx, userId))?.status ?? null;
  }

  async createSsoAccount(v: { id: string; email: string; name: string; firstName: string | null }) {
    await this.tx
      .insertInto('users')
      .values({
        id: v.id,
        email: v.email,
        name: v.name,
        first_name: v.firstName,
        status: 'active',
      })
      .execute();
  }

  activateAccount(userId: string) {
    return this.stores.people.updateAccount(this.tx, userId, { status: 'active' });
  }

  linkIdentity(userId: string, issuer: string, subject: string) {
    return this.stores.identity.linkIdentity(this.tx, {
      userId,
      provider: 'entra',
      issuer,
      subject,
    });
  }

  addMember(userId: string) {
    return this.stores.people.addMember(this.tx, this.tenantId, userId, 'active');
  }

  async adminEmails() {
    const rows = await this.tx
      .selectFrom('memberships as g')
      .innerJoin('users as u', 'u.id', 'g.user_id')
      .select('u.email')
      .distinct()
      .where('g.tenant_id', '=', this.tenantId)
      .where('g.role', 'in', ['owner', 'admin'])
      .execute();
    return rows.map((r) => r.email);
  }

  async passwordSessionUser(tokenHash: string, now: Date) {
    const s = await this.stores.sessions.byToken(this.tx, tokenHash);
    return s && s.mfaState === 'ok' && s.authMethod === 'password' && s.expiresAt > now
      ? s.userId
      : null;
  }

  ssoSettings() {
    return this.stores.identity.sso(this.tx, this.tenantId);
  }

  lockSsoDomains() {
    return this.stores.identity.lockSsoDomains(this.tx);
  }

  ssoDomainOwners(domain: string) {
    return this.stores.identity.domainOwners(this.tx, domain);
  }

  saveSso(v: SsoValues) {
    return this.stores.identity.saveSso(this.tx, this.tenantId, v);
  }

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
    people: new PeopleStore(),
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

  async peekToken(raw: string, purpose: TokenPurpose) {
    const r = await this.db.peekUserToken(sha256Hex(raw), purpose);
    return r
      ? { userId: r.user_id.toLowerCase(), tenantId: r.tenant_id?.toLowerCase() ?? null }
      : null;
  }

  identityUser(issuer: string, subject: string) {
    return this.db.userByIdentity(issuer, subject);
  }

  inUser<T>(userId: string, fn: (t: AccountTx) => Promise<T>) {
    return this.db.withUser(userId, (tx) => fn(new MssqlAuthTx(tx, '', this.stores)));
  }

  revokeEverywhere(userId: string) {
    return this.db.withUser(userId, (tx) => this.stores.sessions.revokeEverywhere(tx, userId));
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

export interface SessionRow {
  id: string;
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
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}
