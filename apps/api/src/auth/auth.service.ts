import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import {
  ROLES_REQUIRING_2FA,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@wansurvey/schema';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { AuditService, type AuditEntry } from '../audit/audit.service.js';
import type { AuthContext, MfaMethod } from '../common/auth-context.js';
import {
  decryptField,
  encryptField,
  generateTotpSecret,
  otpauthUrl,
  randomToken,
  sha256Hex,
  totpStep,
} from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Database, isUuid, type Tx, type UserTenant } from '../db/database.js';
import { SsoConfigs } from './sso-config.js';
import { memberships, sessions, tenantMembers, userTokens, users } from '../db/schema.js';
import { MAILER, type Mailer } from '../mail/mailer.js';

export const MIN_PASSWORD_LENGTH = 10;

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
}

export interface LoginResult {
  cookie: string;
  csrfToken: string;
  mfaState: AuthContext['mfaState'];
  tenant: TenantSummary;
  tenants: TenantSummary[];
}

type TokenPurpose = 'invitation' | 'password_reset';

// A real Argon2id hash, verified when the e-mail is unknown so timing does not reveal accounts.
let dummyHash: Promise<string> | null = null;

export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: 2 /* Argon2id */ });
}

async function verifyPassword(hashed: string | null | undefined, password: string) {
  const target = hashed ?? (await (dummyHash ??= hashPassword('not-a-real-password')));
  const ok = await verify(target, password).catch(() => false);
  return ok && !!hashed;
}

const summary = (t: UserTenant): TenantSummary => ({ id: t.id, slug: t.slug, name: t.name });

const invalidCredentials = () =>
  new UnauthorizedException({
    code: 'INVALID_CREDENTIALS',
    message: 'Invalid e-mail or password',
  });

/**
 * The account is locked after too many failed passwords or codes (from any address). Said only
 * after the password was right (at the code step): at sign-in it would tell that an address
 * has an account.
 */
const accountLocked = (until: Date) =>
  new HttpException(
    {
      statusCode: 429,
      code: 'ACCOUNT_LOCKED',
      message: 'Too many failed attempts. Try again later.',
      retryAfter: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)),
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly ssoConfigs: SsoConfigs,
  ) {}

  /**
   * Accounts are global; a session belongs to one organisation. Without `tenant`, the
   * organisation used last (or the only one) is opened.
   */
  async login(
    input: { email: string; password: string; tenant?: string },
    client: ClientInfo,
  ): Promise<LoginResult> {
    const user = await this.database.authUserByEmail(input.email);
    // A locked account is not tried, so guesses during the lock tell nothing; it answers as a
    // wrong password would, after the same work (an address without an account never locks,
    // so any other answer would tell that one has). Its owner hears of the lock by e-mail.
    const lockedUntil = user ? await this.database.accountLockedUntil(user.id) : null;
    const ok = await verifyPassword(lockedUntil ? null : user?.passwordHash, input.password);
    if (!user || !ok || user.status !== 'active') {
      if (user) {
        if (!ok && !lockedUntil) await this.countFailure(user.id);
        await this.auditEverywhere(user.id, {
          action: 'auth.login_failed',
          actorUserId: user.id,
          details: {
            email: input.email,
            reason: lockedUntil ? 'locked' : ok ? `status_${user.status}` : 'bad_password',
          },
          ...client,
        });
      }
      throw invalidCredentials();
    }
    // With a second factor the count starts again only after the code: otherwise signing in
    // again would reset it between guesses of the code.
    if (!user.totpEnabled) await this.database.accountSucceeded(user.id);
    const tenants = await this.database.userTenants(user.id);
    if (tenants.length === 0) throw invalidCredentials();
    // Organisations that require Microsoft sign-in accept a password only from their owners.
    const enforced = new Set(
      (await this.ssoConfigs.enforced(tenants.map((t) => t.id))).map((e) => e.tenantId),
    );
    const passwordAllowed = async (t: UserTenant) =>
      !enforced.has(t.id) || (await this.isOwnerIn(t.id, user.id));
    let chosen: UserTenant | undefined;
    if (input.tenant) {
      const wanted = input.tenant.toLowerCase();
      chosen = tenants.find((t) => t.slug === wanted || t.id === input.tenant);
      if (!chosen) {
        throw new ForbiddenException({
          code: 'NOT_A_MEMBER',
          message: 'You are not a member of that organisation',
        });
      }
      if (!(await passwordAllowed(chosen))) throw this.ssoRequired(chosen);
    } else {
      const usable: UserTenant[] = [];
      for (const t of tenants) if (await passwordAllowed(t)) usable.push(t);
      if (usable.length === 0) throw this.ssoRequired(tenants[0]!);
      chosen = usable.find((t) => t.id === user.lastTenantId) ?? usable[0]!;
    }
    const session = await this.openSession(chosen.id, user.id, {
      totpEnabled: user.totpEnabled,
      mfaVerifiedBy: null,
      authMethod: 'password',
      action: 'auth.login',
      client,
    });
    return { ...session, tenant: summary(chosen), tenants: tenants.map(summary) };
  }

  async listTenants(ctx: AuthContext): Promise<TenantSummary[]> {
    return (await this.database.userTenants(ctx.userId)).map(summary);
  }

  /** Moves the user to another organisation: the current session ends and a new one starts. */
  async switchTenant(ctx: AuthContext, tenantId: string, client: ClientInfo): Promise<LoginResult> {
    const tenants = await this.database.userTenants(ctx.userId);
    const target = tenants.find((t) => t.id === tenantId);
    if (!target) {
      throw new ForbiddenException({
        code: 'NOT_A_MEMBER',
        message: 'You are not a member of that organisation',
      });
    }
    // Microsoft only: a session from one organisation's directory opens another organisation
    // only through that one's directory (owners included: there is no password to fall back on).
    const adOnly = !this.config.PASSWORD_LOGIN;
    const targetSso = adOnly ? await this.ssoConfigs.forTenant(target.id) : null;
    if (
      adOnly &&
      !(targetSso?.enabled && ctx.authMethod === 'sso' && ctx.idpTenant === targetSso.entraTenantId)
    )
      throw this.ssoRequired(target);
    const [enforced] = adOnly ? [] : await this.ssoConfigs.enforced([target.id]);
    if (
      !adOnly &&
      enforced &&
      !(ctx.authMethod === 'sso' && ctx.idpTenant === enforced.entraTenantId) &&
      !(await this.isOwnerIn(target.id, ctx.userId))
    ) {
      throw this.ssoRequired(target);
    }
    const totpEnabled = await this.database.withTenant(
      ctx.tenantId,
      async (tx) => {
        const [user] = await tx
          .select({ totpEnabled: users.totpEnabled })
          .from(users)
          .where(eq(users.id, ctx.userId));
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(eq(sessions.id, ctx.sessionId));
        await this.audit.record(
          tx,
          ctx.tenantId,
          this.audit.fromContext(ctx, {
            action: 'auth.tenant_switched',
            details: { to: target.id },
          }),
        );
        return user!.totpEnabled;
      },
      ctx.userId,
    );
    const session = await this.openSession(target.id, ctx.userId, {
      totpEnabled,
      // Only a second factor actually verified carries over ('ok' may mean none was needed in
      // the organisation left): a code entered in this browser counts in every organisation;
      // Microsoft's own MFA only in the organisation whose directory performed it.
      mfaVerifiedBy:
        ctx.mfaState !== 'ok'
          ? null
          : ctx.mfaMethod === 'totp'
            ? 'totp'
            : ctx.mfaMethod === 'entra' &&
                ((!!enforced && ctx.idpTenant === enforced.entraTenantId) ||
                  (adOnly && ctx.idpTenant === targetSso?.entraTenantId))
              ? 'entra'
              : null,
      authMethod: ctx.authMethod,
      idpTenant: ctx.idpTenant,
      action: 'auth.login',
      client,
    });
    return { ...session, tenant: summary(target), tenants: tenants.map(summary) };
  }

  /**
   * Starts a session in one organisation. TOTP is skipped when it was already entered in this
   * browser, or when Microsoft reports that it performed MFA (`mfaVerifiedBy`).
   */
  async openSession(
    tenantId: string,
    userId: string,
    opts: {
      totpEnabled: boolean;
      mfaVerifiedBy: MfaMethod | null;
      authMethod: 'password' | 'sso';
      idpTenant?: string | null;
      action: AuditEntry['action'];
      client: ClientInfo;
    },
  ) {
    return this.database.withTenant(
      tenantId,
      (tx) => this.openSessionIn(tx, tenantId, userId, opts),
      userId,
    );
  }

  /**
   * The same, in a transaction already open in the organisation with the account as its user.
   * `roles` and `lastTenantId`, when the caller read them already, spare two statements.
   */
  async openSessionIn(
    tx: Tx,
    tenantId: string,
    userId: string,
    opts: {
      totpEnabled: boolean;
      mfaVerifiedBy: MfaMethod | null;
      authMethod: 'password' | 'sso';
      idpTenant?: string | null;
      action: AuditEntry['action'];
      client: ClientInfo;
      roles?: string[];
      lastTenantId?: string | null;
    },
  ) {
    const roles =
      opts.roles ??
      (
        await tx
          .select({ role: memberships.role })
          .from(memberships)
          .where(eq(memberships.userId, userId))
      ).map((r) => r.role);
    const needs2fa = roles.some((r) => ROLES_REQUIRING_2FA.includes(r as Role));
    const mfaState: AuthContext['mfaState'] = opts.mfaVerifiedBy
      ? 'ok'
      : opts.totpEnabled
        ? 'pending'
        : needs2fa
          ? 'enroll'
          : 'ok';
    const token = randomToken();
    const csrfToken = randomToken(24);
    await tx.insert(sessions).values({
      tenantId,
      userId,
      tokenHash: sha256Hex(token),
      csrfToken,
      mfaState,
      mfaMethod: opts.mfaVerifiedBy,
      authMethod: opts.authMethod,
      idpTenant: opts.idpTenant ?? null,
      ip: opts.client.ip,
      userAgent: opts.client.userAgent,
      expiresAt: new Date(Date.now() + this.config.SESSION_ABSOLUTE_HOURS * 3600_000),
    });
    if (opts.lastTenantId !== tenantId)
      await tx.update(users).set({ lastTenantId: tenantId }).where(eq(users.id, userId));
    await this.audit.record(tx, tenantId, {
      action: opts.action,
      actorUserId: userId,
      details: { mfaState, method: opts.authMethod },
      ...opts.client,
    });
    return { cookie: `${tenantId}.${token}`, csrfToken, mfaState };
  }

  private async isOwnerIn(tenantId: string, userId: string): Promise<boolean> {
    const roles = await this.database.withTenant(tenantId, (tx) =>
      tx.select({ role: memberships.role }).from(memberships).where(eq(memberships.userId, userId)),
    );
    return roles.some((r) => r.role === 'owner');
  }

  private ssoRequired(t: { slug: string; name: string }) {
    return new ForbiddenException({
      code: 'SSO_REQUIRED',
      message: `${t.name} requires signing in with Microsoft`,
      ssoStartUrl: `${this.config.API_PUBLIC_URL}/api/v1/auth/sso/start?org=${encodeURIComponent(t.slug)}`,
    });
  }

  /** Records an account-level event in every organisation the user belongs to. */
  private async auditEverywhere(userId: string, entry: AuditEntry) {
    for (const t of await this.database.userTenants(userId, true)) {
      await this.database.withTenant(t.id, (tx) => this.audit.record(tx, t.id, entry));
    }
  }

  async logout(ctx: AuthContext): Promise<void> {
    await this.database.withTenant(ctx.tenantId, async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, ctx.sessionId));
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, { action: 'auth.logout' }),
      );
    });
  }

  async me(ctx: AuthContext) {
    const [user] = await this.database.withTenant(
      ctx.tenantId,
      (tx) =>
        tx
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            firstName: users.firstName,
            languages: users.languages,
            totpEnabled: users.totpEnabled,
            idCode: tenantMembers.idCode,
            phoneExtension: tenantMembers.phoneExtension,
          })
          .from(users)
          .innerJoin(tenantMembers, eq(tenantMembers.userId, users.id))
          .where(eq(users.id, ctx.userId)),
      ctx.userId,
    );
    const permissions = new Set<Permission>();
    for (const m of ctx.memberships)
      if (m.projectId === null)
        (m.permissions ?? ROLE_PERMISSIONS[m.role]).forEach((p) => permissions.add(p));
    const tenants = await this.listTenants(ctx);
    const orgName = tenants.find((t) => t.id === ctx.tenantId)?.name ?? 'this organisation';
    return {
      user,
      tenantId: ctx.tenantId,
      tenants,
      // People created by a first Microsoft sign-in have no role until an admin assigns one.
      access:
        ctx.memberships.length === 0
          ? {
              state: 'no_role' as const,
              message: `Your account is active, but no role has been assigned to you in ${orgName} yet. An administrator of ${orgName} has been notified and needs to give you access before you can work here.`,
            }
          : { state: 'ok' as const, message: null },
      mfaState: ctx.mfaState,
      csrfToken: ctx.csrfToken,
      memberships: ctx.memberships,
      permissions: [...permissions].sort(),
    };
  }

  // --- two-factor (per account, valid in every organisation) ----------------------

  async setupTotp(ctx: AuthContext) {
    return this.database.withTenant(
      ctx.tenantId,
      async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, ctx.userId));
        if (user!.totpEnabled)
          throw new ConflictException('Two-factor authentication is already enabled');
        const secret = generateTotpSecret();
        await tx
          .update(users)
          .set({ totpSecretEnc: encryptField(secret, this.config.APP_ENCRYPTION_KEY) })
          .where(eq(users.id, ctx.userId));
        return { secret, otpauthUrl: otpauthUrl(secret, user!.email) };
      },
      ctx.userId,
    );
  }

  async enableTotp(ctx: AuthContext, code: string) {
    await this.database.withTenant(
      ctx.tenantId,
      async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, ctx.userId));
        if (user!.totpEnabled)
          throw new ConflictException('Two-factor authentication is already enabled');
        if (!user!.totpSecretEnc) throw new BadRequestException('Start the setup first');
        const secret = decryptField(user!.totpSecretEnc, this.config.APP_ENCRYPTION_KEY);
        const step = totpStep(secret, code);
        if (step === null)
          throw new UnauthorizedException({ code: 'INVALID_CODE', message: 'Invalid code' });
        await tx
          .update(users)
          .set({ totpEnabled: true, totpLastStep: step })
          .where(eq(users.id, ctx.userId));
        await tx
          .update(sessions)
          .set({ mfaState: 'ok', mfaMethod: 'totp' })
          .where(eq(sessions.id, ctx.sessionId));
        await this.audit.record(
          tx,
          ctx.tenantId,
          this.audit.fromContext(ctx, {
            action: 'auth.mfa_enabled',
            targetType: 'user',
            targetId: ctx.userId,
          }),
        );
      },
      ctx.userId,
    );
  }

  async verifyTotp(ctx: AuthContext, code: string) {
    if (ctx.mfaState !== 'pending')
      throw new BadRequestException('No code is expected for this session');
    const lockedUntil = await this.database.accountLockedUntil(ctx.userId);
    if (lockedUntil) throw accountLocked(lockedUntil);
    const ok = await this.database.withTenant(
      ctx.tenantId,
      async (tx) => {
        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.id, ctx.userId))
          // One check at a time per account, so a code cannot be used twice in parallel.
          .for('update');
        const secret = decryptField(user!.totpSecretEnc!, this.config.APP_ENCRYPTION_KEY);
        const step = totpStep(secret, code);
        // Each code works once: a code seen (or stolen) after use is refused.
        const valid = step !== null && (user!.totpLastStep ?? -1) < step;
        if (valid) {
          await tx.update(users).set({ totpLastStep: step }).where(eq(users.id, ctx.userId));
          await tx
            .update(sessions)
            .set({ mfaState: 'ok', mfaMethod: 'totp' })
            .where(eq(sessions.id, ctx.sessionId));
        }
        await this.audit.record(
          tx,
          ctx.tenantId,
          this.audit.fromContext(ctx, { action: valid ? 'auth.mfa_verified' : 'auth.mfa_failed' }),
        );
        return valid;
      },
      ctx.userId,
    );
    if (!ok) {
      await this.countFailure(ctx.userId);
      throw new UnauthorizedException({ code: 'INVALID_CODE', message: 'Invalid code' });
    }
    await this.database.accountSucceeded(ctx.userId);
  }

  /**
   * A failed password or code; enough in a row lock the account (LOGIN_LOCK_AFTER), and its
   * owner is told: sign-in then refuses even the right password without saying why.
   */
  private async countFailure(userId: string) {
    if (!this.config.LOGIN_LOCK_AFTER) return;
    const until = await this.database.accountFailed(
      userId,
      this.config.LOGIN_LOCK_AFTER,
      this.config.LOGIN_LOCK_MINUTES * 60,
    );
    if (until)
      await this.notifyLocked(userId, until).catch((e: unknown) =>
        this.logger.error(`Could not send the lock notice of ${userId}: ${String(e)}`),
      );
  }

  private async notifyLocked(userId: string, until: Date) {
    const [row] = await this.database.withUser(userId, (tx) =>
      tx.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId)),
    );
    if (!row) return;
    await this.mailer.send({
      to: row.email,
      subject: 'Your WanSurvey account is locked for a while',
      text: `Hello ${row.name},\n\nThere were ${this.config.LOGIN_LOCK_AFTER} failed attempts in a row to sign in to your WanSurvey account, so it is locked until ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC. Until then even the right password is refused.\n\nIf it was not you, someone may be guessing your password: choose a new one once the lock ends, and tell your administrator.`,
      idempotencyKey: `locked:${userId}:${until.getTime()}`,
    });
  }

  // --- invitations and password reset -------------------------------------------

  /** Creates a single-use token; only its hash is stored. */
  async issueToken(
    tx: Tx,
    opts: { tenantId: string | null; userId: string; purpose: TokenPurpose; ttlHours: number },
  ): Promise<string> {
    const raw = randomToken();
    await tx.insert(userTokens).values({
      tenantId: opts.tenantId,
      userId: opts.userId,
      purpose: opts.purpose,
      tokenHash: sha256Hex(raw),
      expiresAt: new Date(Date.now() + opts.ttlHours * 3600_000),
    });
    return raw;
  }

  /** Looks a token up without using it, to learn whose and which organisation's it is. */
  private async peekToken(raw: string, purpose: TokenPurpose) {
    const [row] = await this.database.db
      .select({ userId: userTokens.userId, tenantId: userTokens.tenantId })
      .from(userTokens)
      .where(
        and(
          eq(userTokens.tokenHash, sha256Hex(raw)),
          eq(userTokens.purpose, purpose),
          isNull(userTokens.usedAt),
          gt(userTokens.expiresAt, new Date()),
        ),
      );
    if (!row || !isUuid(row.userId)) throw new BadRequestException('Invalid or expired link');
    return row;
  }

  /** Marks the token used inside the caller's transaction (rolled back if the change fails). */
  private async consumeToken(tx: Tx, raw: string) {
    const [row] = await tx
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(userTokens.tokenHash, sha256Hex(raw)), isNull(userTokens.usedAt)))
      .returning({ id: userTokens.id });
    if (!row) throw new BadRequestException('Invalid or expired link');
  }

  /**
   * New people choose their password here. Someone who already has an account confirms with
   * their existing password instead, which links their account to the organisation.
   */
  async acceptInvitation(input: { token: string; password: string }, client: ClientInfo) {
    const token = await this.peekToken(input.token, 'invitation');
    if (!token.tenantId) throw new BadRequestException('Invalid or expired link');
    const tenantId = token.tenantId;
    const newHash = await hashPassword(input.password);
    await this.database.withTenant(
      tenantId,
      async (tx) => {
        await this.consumeToken(tx, input.token);
        const [user] = await tx.select().from(users).where(eq(users.id, token.userId));
        if (!user || user.status === 'disabled')
          throw new BadRequestException('Invalid or expired link');
        if (user.status === 'pending') {
          await tx
            .update(users)
            .set({ passwordHash: newHash, status: 'active' })
            .where(eq(users.id, user.id));
        } else if (!(await verifyPassword(user.passwordHash, input.password))) {
          throw new UnauthorizedException({
            code: 'INVALID_CREDENTIALS',
            message: 'Enter the password of your existing account',
          });
        }
        const [member] = await tx
          .update(tenantMembers)
          .set({ status: 'active' })
          .where(and(eq(tenantMembers.userId, user.id), eq(tenantMembers.status, 'invited')))
          .returning({ id: tenantMembers.id });
        if (!member) throw new BadRequestException('Invalid or expired link');
        await this.audit.record(tx, tenantId, {
          action: 'user.invitation_accepted',
          actorUserId: user.id,
          targetType: 'user',
          targetId: user.id,
          ...client,
        });
      },
      token.userId,
    );
  }

  async forgotPassword(input: { email: string }, client: ClientInfo) {
    const user = await this.database.authUserByEmail(input.email);
    if (!user || user.status !== 'active') return;
    const token = await this.database.withUser(user.id, async (tx) => {
      const raw = await this.issueToken(tx, {
        tenantId: null,
        userId: user.id,
        purpose: 'password_reset',
        ttlHours: 2,
      });
      const [row] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, user.id));
      return { raw, email: row!.email };
    });
    await this.auditEverywhere(user.id, {
      action: 'auth.password_reset_requested',
      targetType: 'user',
      targetId: user.id,
      ...client,
    });
    await this.mailer.send({
      to: token.email,
      subject: 'Reset your WanSurvey password',
      text: `Use this link within 2 hours to choose a new password:\n${this.config.PUBLIC_WEB_URL}/reset-password?token=${encodeURIComponent(token.raw)}`,
      idempotencyKey: `reset:${sha256Hex(token.raw)}`,
    });
  }

  /** A new password ends every session of the account, in every organisation. */
  async resetPassword(input: { token: string; password: string }, client: ClientInfo) {
    const token = await this.peekToken(input.token, 'password_reset');
    const passwordHash = await hashPassword(input.password);
    await this.database.withUser(token.userId, async (tx) => {
      await this.consumeToken(tx, input.token);
      const [user] = await tx.select().from(users).where(eq(users.id, token.userId));
      if (!user || user.status !== 'active') throw new ForbiddenException('Account is not active');
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    });
    await this.database.revokeAllSessions(token.userId);
    await this.auditEverywhere(token.userId, {
      action: 'auth.password_reset',
      actorUserId: token.userId,
      targetType: 'user',
      targetId: token.userId,
      ...client,
    });
  }
}
