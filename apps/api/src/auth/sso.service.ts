import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../audit/audit.service.js';
import { decryptField, encryptField, randomToken, sha256Hex } from '../common/crypto.js';
import { SsoConfigs } from './sso-config.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Database, isUuid, Prepared } from '../db/database.js';
import { memberships, sessions, tenantMembers, userIdentities, users } from '../db/schema.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import { parseSessionCookie } from './auth.guard.js';
import { AuthService, type ClientInfo } from './auth.service.js';

const STATE_TTL_MS = 10 * 60_000;

/** A failed Microsoft sign-in; `code` is passed to the web app as `?sso_error=`. */
export class SsoError extends Error {
  constructor(
    readonly code: string,
    readonly tenantId: string | null = null,
  ) {
    super(code);
    this.name = 'SsoError';
  }
}

/** What survives the round trip to Microsoft, kept in an encrypted httpOnly cookie. */
interface SsoState {
  state: string;
  nonce: string;
  verifier: string;
  tenantId: string;
  entraTenantId: string;
  returnTo: string;
  exp: number;
}

export interface EntraClaims extends JWTPayload {
  tid?: string;
  oid?: string;
  nonce?: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  given_name?: string;
  amr?: string[];
}

/** Only same-site relative paths, so a sign-in can never bounce the browser elsewhere. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\') || /[\r\n]/.test(value)) return '/';
  return value.slice(0, 512);
}

/**
 * A Microsoft identity already linked, with its account and membership here and its roles, in
 * one statement; it also sets the account as the transaction's user, for the session that
 * follows. Read in the organisation's context (row-level security applies).
 */
const linkedAccount = new Prepared<{
  userId: string;
  userStatus: string;
  totpEnabled: boolean;
  lastTenantId: string | null;
  memberStatus: string;
  roles: string[];
}>(
  () => sql`
    select ui.user_id as "userId", u.status as "userStatus", u.totp_enabled as "totpEnabled",
           u.last_tenant_id as "lastTenantId", m.status as "memberStatus",
           array(select g.role from memberships g where g.user_id = ui.user_id) as "roles",
           set_config('app.user_id', ui.user_id::text, true) as "_"
    from user_identities ui
    join users u on u.id = ui.user_id
    join tenant_members m on m.user_id = ui.user_id
    where ui.issuer = ${sql.placeholder('issuer')} and ui.subject = ${sql.placeholder('subject')}`,
  {
    userId: 'raw',
    userStatus: 'raw',
    totpEnabled: 'raw',
    lastTenantId: 'raw',
    memberStatus: 'raw',
    roles: 'raw',
  },
);

const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

/**
 * Microsoft Entra ID (Azure AD) sign-in: OpenID Connect authorization code flow with PKCE,
 * configured per organisation.
 */
@Injectable()
export class SsoService {
  private readonly logger = new Logger('SSO');
  private readonly jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly configs: SsoConfigs,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  get redirectUri(): string {
    return `${this.config.API_PUBLIC_URL}/api/v1/auth/sso/callback`;
  }

  private authority(entraTenantId: string): string {
    return `${this.config.ENTRA_AUTHORITY_HOST.replace(/\/$/, '')}/${encodeURIComponent(entraTenantId)}`;
  }

  /**
   * Builds the Microsoft authorize URL and the encrypted state cookie value. The organisation
   * comes from `org`, or from the e-mail's domain, or else is the default one (SSO_DEFAULT_ORG:
   * the sign-in button alone).
   */
  async start(input: { org?: string; email?: string; returnTo?: string }) {
    let tenantId: string | null = null;
    if (input.org) {
      tenantId = await this.configs.tenantIdBySlug(input.org);
    } else if (input.email && input.email.includes('@')) {
      const domain = input.email.split('@').pop()!.trim().toLowerCase();
      tenantId = await this.configs.deploymentTenantForDomain(domain);
      if (!tenantId) {
        const matches = await this.database.ssoTenantsForDomain(domain);
        if (matches.length > 1) throw new SsoError('choose_organisation');
        tenantId = matches[0]?.tenantId ?? null;
      }
    } else {
      tenantId = await this.configs.defaultTenantId();
      if (!tenantId) throw new SsoError('choose_organisation');
    }
    const config = tenantId ? await this.configs.forTenant(tenantId) : null;
    if (!config || !config.enabled)
      throw new SsoError('sso_not_configured', config?.tenantId ?? null);

    const st: SsoState = {
      state: randomToken(24),
      nonce: randomToken(24),
      verifier: randomToken(48),
      tenantId: config.tenantId,
      entraTenantId: config.entraTenantId,
      returnTo: safeReturnTo(input.returnTo),
      exp: Date.now() + STATE_TTL_MS,
    };
    const url = new URL(`${this.authority(config.entraTenantId)}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: this.redirectUri,
      scope: 'openid profile email',
      state: st.state,
      nonce: st.nonce,
      code_challenge: pkceChallenge(st.verifier),
      code_challenge_method: 'S256',
    }).toString();
    return {
      url: url.toString(),
      cookie: encryptField(JSON.stringify(st), this.config.APP_ENCRYPTION_KEY),
    };
  }

  readState(cookie: unknown, state: unknown): SsoState {
    if (typeof cookie !== 'string' || typeof state !== 'string')
      throw new SsoError('invalid_state');
    let st: SsoState;
    try {
      st = JSON.parse(decryptField(cookie, this.config.APP_ENCRYPTION_KEY)) as SsoState;
    } catch {
      throw new SsoError('invalid_state');
    }
    if (st.state !== state || st.exp < Date.now() || !isUuid(st.tenantId)) {
      throw new SsoError('invalid_state', isUuid(st.tenantId) ? st.tenantId : null);
    }
    return st;
  }

  /**
   * The account signed in in this browser with its password and second factor, if any: the
   * only proof that lets a Microsoft identity join an account of several organisations.
   */
  async signedInUser(cookie: unknown): Promise<string | null> {
    const parsed = parseSessionCookie(cookie);
    if (!parsed) return null;
    return this.database.withTenant(parsed.tenantId, async (tx) => {
      const [row] = await tx
        .select({ userId: sessions.userId })
        .from(sessions)
        .where(
          and(
            eq(sessions.tokenHash, sha256Hex(parsed.token)),
            isNull(sessions.revokedAt),
            eq(sessions.mfaState, 'ok'),
            eq(sessions.authMethod, 'password'),
            gt(sessions.expiresAt, new Date()),
          ),
        );
      return row?.userId ?? null;
    });
  }

  /**
   * Completes the sign-in: code exchange, token checks, account resolution, session.
   * `signedInUser` is asked only when a Microsoft identity is to be linked to an account.
   */
  async callback(
    st: SsoState,
    code: string,
    client: ClientInfo,
    signedInUser: () => Promise<string | null> = async () => null,
  ): Promise<{ cookie: string; csrfToken: string; mfaState: string; returnTo: string }> {
    const fail = (c: string) => new SsoError(c, st.tenantId);
    const config = await this.configs.forTenant(st.tenantId);
    if (
      !config ||
      !config.enabled ||
      !config.clientSecret ||
      config.entraTenantId !== st.entraTenantId
    ) {
      throw fail('sso_not_configured');
    }
    const claims = await this.redeem(
      config.entraTenantId,
      config.clientId,
      config.clientSecret,
      code,
      st,
    );
    const email = (claims.email ?? claims.preferred_username ?? '').toLowerCase();
    const domain = email.includes('@') ? email.split('@').pop()! : '';

    const issuer = claims.iss!;
    const subject = claims.oid!;
    // Trust Microsoft's MFA: skip WanSurvey's TOTP when the token says MFA was performed.
    const mfa = Array.isArray(claims.amr) && claims.amr.includes('mfa');

    // The usual case, every morning: an identity already linked, to an active account that is
    // an active member here. One transaction reads it and opens the session.
    const quick = await this.database.withTenant(st.tenantId, async (tx) => {
      const [a] = await linkedAccount.run(tx, { issuer, subject });
      if (!a || a.userStatus !== 'active' || a.memberStatus !== 'active') return null;
      return this.auth.openSessionIn(tx, st.tenantId, a.userId, {
        totpEnabled: a.totpEnabled,
        mfaAlreadyVerified: mfa,
        authMethod: 'sso',
        idpTenant: config.entraTenantId,
        action: 'auth.login',
        client,
        roles: a.roles,
        lastTenantId: a.lastTenantId,
      });
    });
    if (quick) return { ...quick, returnTo: st.returnTo };
    const [identity] = await this.database.db
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(and(eq(userIdentities.issuer, issuer), eq(userIdentities.subject, subject)));
    if (!identity && !config.allowedDomains.includes(domain)) throw fail('domain_not_allowed');
    const existingId = identity?.userId ?? (await this.database.userIdByEmail(email));
    // An e-mail address in a token proves nothing about an account elsewhere: whoever runs
    // this organisation's directory can put any address there. A Microsoft identity is linked
    // to an existing account by e-mail only when that account belongs to this organisation
    // alone, or when its owner is signed in with it in this browser (password and second
    // factor); otherwise they sign in with their password first.
    // With password sign-in off there is no password to prove it with. Linking by e-mail is
    // then safe on other grounds: an e-mail domain belongs to one organisation only (the
    // settings refuse a domain another uses), and a session opened through this directory
    // works in this organisation alone (switching requires each organisation's own directory).
    if (
      !identity &&
      existingId &&
      this.config.PASSWORD_LOGIN &&
      (await signedInUser()) !== existingId
    ) {
      const elsewhere = (await this.database.userTenants(existingId, true)).filter(
        (t) => t.id !== st.tenantId,
      );
      if (elsewhere.length) throw fail('link_required');
    }
    const userId = existingId ?? uuidv7();

    const outcome = await this.database.withTenant(
      st.tenantId,
      async (tx) => {
        let accountCreated = false;
        if (!existingId) {
          await tx.insert(users).values({
            id: userId,
            email,
            name: claims.name ?? email,
            firstName: claims.given_name ?? null,
            status: 'active',
          });
          accountCreated = true;
        } else {
          const [u] = await tx
            .select({ status: users.status })
            .from(users)
            .where(eq(users.id, userId));
          if (!u || u.status === 'disabled') throw fail('account_disabled');
          // Microsoft has proven who they are, so an invited account without a password is usable.
          if (u.status === 'pending')
            await tx.update(users).set({ status: 'active' }).where(eq(users.id, userId));
        }
        if (!identity) {
          await tx.insert(userIdentities).values({ userId, provider: 'entra', issuer, subject });
          if (existingId) {
            await this.audit.record(tx, st.tenantId, {
              action: 'user.identity_linked',
              actorUserId: userId,
              targetType: 'user',
              targetId: userId,
              details: { provider: 'entra', email },
              ...client,
            });
          }
        }
        const [member] = await tx
          .select({ status: tenantMembers.status })
          .from(tenantMembers)
          .where(eq(tenantMembers.userId, userId));
        let provisioned = false;
        if (!member) {
          // First Microsoft sign-in: a member with no role, waiting for an administrator.
          await tx
            .insert(tenantMembers)
            .values({ tenantId: st.tenantId, userId, status: 'active' });
          await this.audit.record(tx, st.tenantId, {
            action: 'user.provisioned_sso',
            actorUserId: userId,
            targetType: 'user',
            targetId: userId,
            details: { email, accountCreated },
            ...client,
          });
          provisioned = true;
        } else if (member.status === 'deactivated') {
          throw fail('membership_deactivated');
        } else if (member.status === 'invited') {
          await tx
            .update(tenantMembers)
            .set({ status: 'active' })
            .where(eq(tenantMembers.userId, userId));
          await this.audit.record(tx, st.tenantId, {
            action: 'user.invitation_accepted',
            actorUserId: userId,
            targetType: 'user',
            targetId: userId,
            details: { method: 'sso' },
            ...client,
          });
        }
        const [u] = await tx
          .select({ totpEnabled: users.totpEnabled })
          .from(users)
          .where(eq(users.id, userId));
        return { provisioned, totpEnabled: u!.totpEnabled };
      },
      userId,
    );

    const session = await this.auth.openSession(st.tenantId, userId, {
      totpEnabled: outcome.totpEnabled,
      mfaAlreadyVerified: mfa,
      authMethod: 'sso',
      idpTenant: config.entraTenantId,
      action: 'auth.login',
      client,
    });
    if (outcome.provisioned) await this.notifyAdmins(st.tenantId, email, claims.name ?? email);
    return { ...session, returnTo: st.returnTo };
  }

  /** Exchanges the code at the token endpoint and verifies the ID token. */
  private async redeem(
    entraTenantId: string,
    clientId: string,
    clientSecret: string,
    code: string,
    st: SsoState,
  ): Promise<EntraClaims> {
    const authority = this.authority(entraTenantId);
    let idToken: string;
    try {
      const res = await fetch(`${authority}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri,
          code_verifier: st.verifier,
          scope: 'openid profile email',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
      if (!res.ok || !body.id_token) {
        this.logger.warn(`Token exchange failed (${res.status}): ${body.error ?? 'no id_token'}`);
        throw new SsoError('token_exchange_failed', st.tenantId);
      }
      idToken = body.id_token;
    } catch (e) {
      if (e instanceof SsoError) throw e;
      throw new SsoError('token_exchange_failed', st.tenantId);
    }

    const keysUrl = `${authority}/discovery/v2.0/keys`;
    let jwks = this.jwks.get(keysUrl);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(keysUrl));
      this.jwks.set(keysUrl, jwks);
    }
    let claims: EntraClaims;
    try {
      ({ payload: claims } = await jwtVerify<EntraClaims>(idToken, jwks, {
        issuer: `${authority}/v2.0`,
        audience: clientId,
        algorithms: ['RS256'],
        clockTolerance: 120,
      }));
    } catch {
      throw new SsoError('invalid_token', st.tenantId);
    }
    if (
      claims.nonce !== st.nonce ||
      claims.tid !== entraTenantId ||
      typeof claims.oid !== 'string'
    ) {
      throw new SsoError('invalid_token', st.tenantId);
    }
    return claims;
  }

  private async notifyAdmins(tenantId: string, email: string, name: string) {
    const admins = await this.database.withTenant(tenantId, (tx) =>
      tx
        .selectDistinct({ email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(inArray(memberships.role, ['owner', 'admin']), eq(memberships.tenantId, tenantId)),
        ),
    );
    for (const a of admins) {
      await this.mailer.send({
        to: a.email,
        subject: `${name} is waiting for access to WanSurvey`,
        text: `${name} (${email}) signed in with Microsoft and has no role yet.\nAssign a role in WanSurvey under Users to give them access.`,
        idempotencyKey: `sso-pending:${tenantId}:${email}:${a.email}`,
      });
    }
  }

  async recordFailure(tenantId: string | null, code: string, client: ClientInfo) {
    if (!tenantId) return;
    await this.database.withTenant(tenantId, (tx) =>
      this.audit.record(tx, tenantId, { action: 'auth.sso_failed', details: { code }, ...client }),
    );
  }
}
