import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import {
  ROLES_REQUIRING_2FA,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@wansurvey/schema';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/auth-context.js';
import {
  decryptField,
  encryptField,
  generateTotpSecret,
  otpauthUrl,
  randomToken,
  sha256Hex,
  verifyTotp,
} from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Database, isUuid, type Tx } from '../db/database.js';
import { memberships, sessions, userTokens, users } from '../db/schema.js';
import { MAILER, type Mailer } from '../mail/mailer.js';

export const MIN_PASSWORD_LENGTH = 10;

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface LoginResult {
  cookie: string;
  csrfToken: string;
  mfaState: AuthContext['mfaState'];
}

// A real Argon2id hash, verified when the e-mail is unknown so timing does not reveal accounts.
let dummyHash: Promise<string> | null = null;

export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: 2 /* Argon2id */ });
}

/** Tokens embed the tenant id so they can be resolved without a session: `<tenantId>.<random>`. */
export function splitTenantToken(token: string): { tenantId: string; raw: string } {
  const dot = token.indexOf('.');
  const tenantId = token.slice(0, dot);
  const raw = token.slice(dot + 1);
  if (dot < 0 || !isUuid(tenantId) || raw.length < 20)
    throw new BadRequestException('Invalid or expired link');
  return { tenantId, raw };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async login(
    input: { tenant: string; email: string; password: string },
    client: ClientInfo,
  ): Promise<LoginResult> {
    const invalid = () =>
      new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid organisation, e-mail or password',
      });
    const tenantId = await this.database.tenantIdBySlug(input.tenant);
    if (!tenantId) {
      await verify(await (dummyHash ??= hashPassword('not-a-real-password')), input.password).catch(
        () => false,
      );
      throw invalid();
    }
    const result = await this.database.withTenant(tenantId, async (tx) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = lower(${input.email})`)
        .limit(1);
      const ok = user?.passwordHash
        ? await verify(user.passwordHash, input.password).catch(() => false)
        : await verify(
            await (dummyHash ??= hashPassword('not-a-real-password')),
            input.password,
          ).catch(() => false);
      if (!user || !ok || user.status !== 'active') {
        await this.audit.record(tx, tenantId, {
          action: 'auth.login_failed',
          actorUserId: user?.id ?? null,
          details: {
            email: input.email,
            reason: !user ? 'unknown_email' : !ok ? 'bad_password' : `status_${user.status}`,
          },
          ...client,
        });
        return null;
      }
      const roles = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(eq(memberships.userId, user.id));
      const needs2fa = roles.some((r) => ROLES_REQUIRING_2FA.includes(r.role as Role));
      const mfaState: AuthContext['mfaState'] = user.totpEnabled
        ? 'pending'
        : needs2fa
          ? 'enroll'
          : 'ok';
      const token = randomToken();
      const csrfToken = randomToken(24);
      const now = Date.now();
      await tx.insert(sessions).values({
        tenantId,
        userId: user.id,
        tokenHash: sha256Hex(token),
        csrfToken,
        mfaState,
        ip: client.ip,
        userAgent: client.userAgent,
        expiresAt: new Date(now + this.config.SESSION_ABSOLUTE_HOURS * 3600_000),
      });
      await this.audit.record(tx, tenantId, {
        action: 'auth.login',
        actorUserId: user.id,
        details: { mfaState },
        ...client,
      });
      return { cookie: `${tenantId}.${token}`, csrfToken, mfaState };
    });
    if (!result) throw invalid();
    return result;
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
    const [user] = await this.database.withTenant(ctx.tenantId, (tx) =>
      tx
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          firstName: users.firstName,
          idCode: users.idCode,
          languages: users.languages,
          totpEnabled: users.totpEnabled,
        })
        .from(users)
        .where(eq(users.id, ctx.userId)),
    );
    const permissions = new Set<Permission>();
    for (const m of ctx.memberships)
      if (m.projectId === null) ROLE_PERMISSIONS[m.role].forEach((p) => permissions.add(p));
    return {
      user,
      tenantId: ctx.tenantId,
      mfaState: ctx.mfaState,
      csrfToken: ctx.csrfToken,
      memberships: ctx.memberships,
      permissions: [...permissions].sort(),
    };
  }

  // --- two-factor -------------------------------------------------------------

  async setupTotp(ctx: AuthContext) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, ctx.userId));
      if (user!.totpEnabled)
        throw new ConflictException('Two-factor authentication is already enabled');
      const secret = generateTotpSecret();
      await tx
        .update(users)
        .set({ totpSecretEnc: encryptField(secret, this.config.APP_ENCRYPTION_KEY) })
        .where(eq(users.id, ctx.userId));
      return { secret, otpauthUrl: otpauthUrl(secret, user!.email) };
    });
  }

  async enableTotp(ctx: AuthContext, code: string) {
    await this.database.withTenant(ctx.tenantId, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, ctx.userId));
      if (user!.totpEnabled)
        throw new ConflictException('Two-factor authentication is already enabled');
      if (!user!.totpSecretEnc) throw new BadRequestException('Start the setup first');
      const secret = decryptField(user!.totpSecretEnc, this.config.APP_ENCRYPTION_KEY);
      if (!verifyTotp(secret, code))
        throw new UnauthorizedException({ code: 'INVALID_CODE', message: 'Invalid code' });
      await tx.update(users).set({ totpEnabled: true }).where(eq(users.id, ctx.userId));
      await tx.update(sessions).set({ mfaState: 'ok' }).where(eq(sessions.id, ctx.sessionId));
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'auth.mfa_enabled',
          targetType: 'user',
          targetId: ctx.userId,
        }),
      );
    });
  }

  async verifyTotp(ctx: AuthContext, code: string) {
    if (ctx.mfaState !== 'pending')
      throw new BadRequestException('No code is expected for this session');
    const ok = await this.database.withTenant(ctx.tenantId, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, ctx.userId));
      const secret = decryptField(user!.totpSecretEnc!, this.config.APP_ENCRYPTION_KEY);
      const valid = verifyTotp(secret, code);
      if (valid)
        await tx.update(sessions).set({ mfaState: 'ok' }).where(eq(sessions.id, ctx.sessionId));
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, { action: valid ? 'auth.mfa_verified' : 'auth.mfa_failed' }),
      );
      return valid;
    });
    if (!ok) throw new UnauthorizedException({ code: 'INVALID_CODE', message: 'Invalid code' });
  }

  // --- invitations and password reset -------------------------------------------

  /** Creates a single-use token; only its hash is stored. */
  async issueToken(
    tx: Tx,
    tenantId: string,
    userId: string,
    purpose: 'invitation' | 'password_reset',
    ttlHours: number,
  ) {
    const raw = randomToken();
    await tx.insert(userTokens).values({
      tenantId,
      userId,
      purpose,
      tokenHash: sha256Hex(raw),
      expiresAt: new Date(Date.now() + ttlHours * 3600_000),
    });
    return `${tenantId}.${raw}`;
  }

  private async consumeToken(tx: Tx, raw: string, purpose: 'invitation' | 'password_reset') {
    const [row] = await tx
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(userTokens.tokenHash, sha256Hex(raw)),
          eq(userTokens.purpose, purpose),
          isNull(userTokens.usedAt),
          gt(userTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: userTokens.userId });
    if (!row) throw new BadRequestException('Invalid or expired link');
    return row.userId;
  }

  async acceptInvitation(input: { token: string; password: string }, client: ClientInfo) {
    const { tenantId, raw } = splitTenantToken(input.token);
    const passwordHash = await hashPassword(input.password);
    await this.database.withTenant(tenantId, async (tx) => {
      const userId = await this.consumeToken(tx, raw, 'invitation');
      const [user] = await tx
        .update(users)
        .set({ passwordHash, status: 'active' })
        .where(and(eq(users.id, userId), eq(users.status, 'invited')))
        .returning({ id: users.id });
      if (!user) throw new BadRequestException('Invalid or expired link');
      await this.audit.record(tx, tenantId, {
        action: 'user.invitation_accepted',
        actorUserId: userId,
        targetType: 'user',
        targetId: userId,
        ...client,
      });
    });
  }

  async forgotPassword(input: { tenant: string; email: string }, client: ClientInfo) {
    const tenantId = await this.database.tenantIdBySlug(input.tenant);
    if (!tenantId) return;
    const sent = await this.database.withTenant(tenantId, async (tx) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(and(sql`lower(${users.email}) = lower(${input.email})`, eq(users.status, 'active')))
        .limit(1);
      if (!user) return null;
      const token = await this.issueToken(tx, tenantId, user.id, 'password_reset', 2);
      await this.audit.record(tx, tenantId, {
        action: 'auth.password_reset_requested',
        targetType: 'user',
        targetId: user.id,
        ...client,
      });
      return { email: user.email, token };
    });
    if (sent) {
      await this.mailer.send({
        to: sent.email,
        subject: 'Reset your WanSurvey password',
        text: `Use this link within 2 hours to choose a new password:\n${this.config.PUBLIC_WEB_URL}/reset-password?token=${encodeURIComponent(sent.token)}`,
        idempotencyKey: `reset:${sha256Hex(sent.token)}`,
      });
    }
  }

  async resetPassword(input: { token: string; password: string }, client: ClientInfo) {
    const { tenantId, raw } = splitTenantToken(input.token);
    const passwordHash = await hashPassword(input.password);
    await this.database.withTenant(tenantId, async (tx) => {
      const userId = await this.consumeToken(tx, raw, 'password_reset');
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user || user.status !== 'active') throw new ForbiddenException('Account is not active');
      await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      await this.audit.record(tx, tenantId, {
        action: 'auth.password_reset',
        actorUserId: userId,
        targetType: 'user',
        targetId: userId,
        ...client,
      });
    });
  }
}
