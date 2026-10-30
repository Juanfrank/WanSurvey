import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { instant } from '../db/mssql/instant.js';
import type { MssqlTx } from '../db/mssql/database.js';

/**
 * Sessions and one-time tokens on SQL Server (Kysely): what `auth.service.ts` and `auth.guard.ts`
 * do on PostgreSQL with Drizzle, as a store for the switch (docs/roadmap.md). Sessions belong to
 * an organisation (the transaction of `MssqlDatabase.withTenant`); tokens are global, hashed, and
 * work once.
 */
export interface SessionRow {
  id: string;
  tenantId: string;
  userId: string;
  csrfToken: string;
  mfaState: string;
  mfaMethod: string | null;
  authMethod: string;
  idpTenant: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  email: string;
  userStatus: string;
  memberStatus: string;
  rolePermissions: Record<string, unknown>;
  grants: { role: string; projectId: string | null }[];
}

const lower = (s: string | null) => (s === null ? null : s.toLowerCase());

export class SessionsStore {
  /**
   * The live session a cookie's token belongs to, with the person, their standing in this
   * organisation, the organisation's role changes and the roles they hold.
   */
  async byToken(tx: MssqlTx, tokenHash: string): Promise<SessionRow | null> {
    const row = await tx
      .selectFrom('sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .innerJoin('tenant_members as m', (j) =>
        j.onRef('m.user_id', '=', 's.user_id').onRef('m.tenant_id', '=', 's.tenant_id'),
      )
      .innerJoin('tenants as t', 't.id', 's.tenant_id')
      .select([
        's.id',
        's.tenant_id',
        's.user_id',
        's.csrf_token',
        's.mfa_state',
        's.mfa_method',
        's.auth_method',
        's.idp_tenant',
        's.created_at',
        's.last_seen_at',
        's.expires_at',
        'u.email',
        'u.status as user_status',
        'm.status as member_status',
        't.role_permissions',
      ])
      .where('s.token_hash', '=', tokenHash)
      .where('s.revoked_at', 'is', null)
      .executeTakeFirst();
    if (!row) return null;
    const grants = await tx
      .selectFrom('memberships')
      .select(['role', 'project_id'])
      .where('user_id', '=', row.user_id)
      .execute();
    return {
      id: row.id.toLowerCase(),
      tenantId: row.tenant_id.toLowerCase(),
      userId: row.user_id.toLowerCase(),
      csrfToken: row.csrf_token,
      mfaState: row.mfa_state,
      mfaMethod: row.mfa_method,
      authMethod: row.auth_method,
      idpTenant: row.idp_tenant,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: new Date(row.expires_at),
      email: row.email,
      userStatus: row.user_status,
      memberStatus: row.member_status,
      rolePermissions: JSON.parse(row.role_permissions) as Record<string, unknown>,
      grants: grants.map((g) => ({ role: g.role, projectId: lower(g.project_id) })),
    };
  }

  async open(
    tx: MssqlTx,
    v: {
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
      /** The organisation the person opened last; updated when it differs. */
      lastTenantId?: string | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('sessions')
      .values({
        id,
        tenant_id: v.tenantId,
        user_id: v.userId,
        token_hash: v.tokenHash,
        csrf_token: v.csrfToken,
        mfa_state: v.mfaState,
        mfa_method: v.mfaMethod,
        auth_method: v.authMethod,
        idp_tenant: v.idpTenant,
        ip: v.ip,
        user_agent: v.userAgent,
        expires_at: instant(v.expiresAt),
      })
      .execute();
    if (v.lastTenantId?.toLowerCase() !== v.tenantId.toLowerCase())
      await tx
        .updateTable('users')
        .set({ last_tenant_id: v.tenantId })
        .where('id', '=', v.userId)
        .execute();
    return id;
  }

  async touch(tx: MssqlTx, id: string, at = new Date()): Promise<void> {
    await tx
      .updateTable('sessions')
      .set({ last_seen_at: instant(at) })
      .where('id', '=', id)
      .execute();
  }

  async revoke(tx: MssqlTx, id: string, at = new Date()): Promise<void> {
    await tx
      .updateTable('sessions')
      .set({ revoked_at: instant(at) })
      .where('id', '=', id)
      .execute();
  }

  /** Sets the second-factor state of a session (a code entered, or enrolment done). */
  async setMfa(
    tx: MssqlTx,
    id: string,
    v: { state: string; method: string | null },
  ): Promise<void> {
    await tx
      .updateTable('sessions')
      .set({ mfa_state: v.state, mfa_method: v.method })
      .where('id', '=', id)
      .execute();
  }

  /** Revokes the person's live sessions in the organisation in context; returns how many. */
  async revokeAllOf(tx: MssqlTx, userId: string, at = new Date()): Promise<number> {
    const res = await tx
      .updateTable('sessions')
      .set({ revoked_at: instant(at) })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows);
  }

  /** Revokes the person's live sessions in every organisation (password reset). */
  async revokeEverywhere(tx: MssqlTx, userId: string): Promise<number> {
    const res = await sql<{ n: number }>`EXEC dbo.revoke_user_sessions ${userId}`.execute(tx);
    return res.rows[0]?.n ?? 0;
  }

  // ─── One-time tokens ────────────────────────────────────────────────────────────────

  async issueToken(
    tx: MssqlTx,
    v: {
      tenantId: string | null;
      userId: string;
      purpose: string;
      tokenHash: string;
      expiresAt: Date;
    },
  ): Promise<void> {
    await tx
      .insertInto('user_tokens')
      .values({
        id: randomUUID(),
        tenant_id: v.tenantId,
        user_id: v.userId,
        purpose: v.purpose,
        token_hash: v.tokenHash,
        expires_at: instant(v.expiresAt),
      })
      .execute();
  }

  /** Who a live token of the purpose belongs to, without using it. */
  async peekToken(
    tx: MssqlTx,
    tokenHash: string,
    purpose: string,
  ): Promise<{ userId: string; tenantId: string | null } | null> {
    const r = await tx
      .selectFrom('user_tokens')
      .select(['user_id', 'tenant_id'])
      .where('token_hash', '=', tokenHash)
      .where('purpose', '=', purpose)
      .where('used_at', 'is', null)
      .where('expires_at', '>', instant(new Date()))
      .executeTakeFirst();
    return r ? { userId: r.user_id.toLowerCase(), tenantId: lower(r.tenant_id) } : null;
  }

  /** Uses a live token once: true for the one call that gets it, even when two race. */
  async useToken(tx: MssqlTx, tokenHash: string): Promise<boolean> {
    const res = await tx
      .updateTable('user_tokens')
      .set({ used_at: instant(new Date()) })
      .where('token_hash', '=', tokenHash)
      .where('used_at', 'is', null)
      .where('expires_at', '>', instant(new Date()))
      .executeTakeFirst();
    return Number(res.numUpdatedRows) === 1;
  }

  /** Voids the person's unused tokens of the purpose (a new invitation replaces the last). */
  async voidTokens(tx: MssqlTx, userId: string, purpose: string): Promise<void> {
    await tx
      .updateTable('user_tokens')
      .set({ used_at: instant(new Date()) })
      .where('user_id', '=', userId)
      .where('purpose', '=', purpose)
      .where('used_at', 'is', null)
      .execute();
  }
}
