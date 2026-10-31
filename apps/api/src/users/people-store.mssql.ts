import { randomUUID } from 'node:crypto';
import type { MssqlTx } from '../db/mssql/database.js';

/**
 * The people of an organisation on SQL Server (Kysely), for `users.service.ts`. Accounts are global; an
 * organisation sees a person through its member row, and gives them roles (memberships, whole
 * organisation or one project). Takes the transaction of `MssqlDatabase.withTenant`; changes to
 * an account's own fields need the person in context (`withTenant(…, userId)`).
 */
export interface Member {
  id: string;
  email: string;
  name: string;
  firstName: string | null;
  phone: string | null;
  languages: string[];
  totpEnabled: boolean;
  status: string;
  idCode: string | null;
  phoneExtension: string | null;
  createdAt: Date;
  deactivatedAt: Date | null;
}

export interface Grant {
  role: string;
  projectId: string | null;
}

const lower = (s: string | null) => (s === null ? null : s.toLowerCase());

export class PeopleStore {
  /** Every member of the organisation in context, by name. */
  async members(tx: MssqlTx): Promise<Member[]> {
    const rows = await tx
      .selectFrom('tenant_members as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select([
        'u.id',
        'u.email',
        'u.name',
        'u.first_name',
        'u.phone',
        'u.languages',
        'u.totp_enabled',
        'm.status',
        'm.id_code',
        'm.phone_extension',
        'm.created_at',
        'm.deactivated_at',
      ])
      .orderBy('u.name')
      .execute();
    return rows.map((r) => ({
      id: r.id.toLowerCase(),
      email: r.email,
      name: r.name,
      firstName: r.first_name,
      phone: r.phone,
      languages: JSON.parse(r.languages) as string[],
      totpEnabled: !!r.totp_enabled,
      status: r.status,
      idCode: r.id_code,
      phoneExtension: r.phone_extension,
      createdAt: r.created_at,
      deactivatedAt: r.deactivated_at,
    }));
  }

  async member(tx: MssqlTx, userId: string): Promise<(Member & { userStatus: string }) | null> {
    const found = (await this.members(tx)).find((m) => m.id === userId.toLowerCase());
    if (!found) return null;
    const u = await tx
      .selectFrom('users')
      .select('status')
      .where('id', '=', userId)
      .executeTakeFirst();
    return { ...found, userStatus: u?.status ?? 'pending' };
  }

  /** The roles of everyone in the organisation (or of one person). */
  async grants(tx: MssqlTx, userId?: string): Promise<(Grant & { userId: string })[]> {
    let q = tx.selectFrom('memberships').select(['user_id', 'role', 'project_id']);
    if (userId) q = q.where('user_id', '=', userId);
    return (await q.execute()).map((g) => ({
      userId: g.user_id.toLowerCase(),
      role: g.role,
      projectId: lower(g.project_id),
    }));
  }

  /** Replaces a person's roles in the organisation. */
  async setGrants(tx: MssqlTx, tenantId: string, userId: string, grants: Grant[]): Promise<void> {
    await tx.deleteFrom('memberships').where('user_id', '=', userId).execute();
    if (grants.length)
      await tx
        .insertInto('memberships')
        .values(
          grants.map((g) => ({
            id: randomUUID(),
            tenant_id: tenantId,
            user_id: userId,
            role: g.role,
            project_id: g.projectId,
          })),
        )
        .execute();
  }

  /** The ids of those projects that exist in the organisation. */
  async existingProjects(tx: MssqlTx, ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    return (await tx.selectFrom('projects').select('id').where('id', 'in', ids).execute()).map(
      (p) => p.id.toLowerCase(),
    );
  }

  /** A new global account (invited, no password yet) and its member row, with its roles. */
  async invite(
    tx: MssqlTx,
    v: {
      tenantId: string;
      userId: string;
      email: string;
      name: string;
      firstName?: string | null;
      idCode?: string | null;
      languages?: string[];
      grants: Grant[];
      /** The account exists already: it is linked, not created. */
      existing: boolean;
    },
  ): Promise<void> {
    if (!v.existing)
      await tx
        .insertInto('users')
        .values({
          id: v.userId,
          email: v.email,
          name: v.name,
          first_name: v.firstName ?? null,
          languages: JSON.stringify(v.languages ?? []),
          last_tenant_id: v.tenantId,
        })
        .execute();
    await tx
      .insertInto('tenant_members')
      .values({
        id: randomUUID(),
        tenant_id: v.tenantId,
        user_id: v.userId,
        status: 'invited',
        id_code: v.idCode ?? null,
      })
      .execute();
    await this.setGrants(tx, v.tenantId, v.userId, v.grants);
  }

  async setMemberStatus(
    tx: MssqlTx,
    userId: string,
    status: 'invited' | 'active' | 'deactivated',
  ): Promise<void> {
    await tx
      .updateTable('tenant_members')
      .set({
        status,
        deactivated_at: status === 'deactivated' ? new Date() : null,
      })
      .where('user_id', '=', userId)
      .execute();
  }

  /** The person's own account fields; needs the person in context. */
  async updateAccount(
    tx: MssqlTx,
    userId: string,
    v: Partial<{
      name: string;
      firstName: string | null;
      phone: string | null;
      languages: string[];
      status: string;
      passwordHash: string | null;
      totpSecretEnc: string | null;
      totpEnabled: boolean;
      totpLastStep: number | null;
    }>,
  ): Promise<void> {
    await tx
      .updateTable('users')
      .set({
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.firstName !== undefined ? { first_name: v.firstName } : {}),
        ...(v.phone !== undefined ? { phone: v.phone } : {}),
        ...(v.languages !== undefined ? { languages: JSON.stringify(v.languages) } : {}),
        ...(v.status !== undefined ? { status: v.status } : {}),
        ...(v.passwordHash !== undefined ? { password_hash: v.passwordHash } : {}),
        ...(v.totpSecretEnc !== undefined ? { totp_secret_enc: v.totpSecretEnc } : {}),
        ...(v.totpEnabled !== undefined ? { totp_enabled: v.totpEnabled } : {}),
        ...(v.totpLastStep !== undefined ? { totp_last_step: v.totpLastStep } : {}),
      })
      .where('id', '=', userId)
      .execute();
  }

  /** Adds the account to the organisation as a member (Microsoft first sign-in). */
  async addMember(
    tx: MssqlTx,
    tenantId: string,
    userId: string,
    status: 'invited' | 'active',
  ): Promise<void> {
    await tx
      .insertInto('tenant_members')
      .values({ id: randomUUID(), tenant_id: tenantId, user_id: userId, status })
      .execute();
  }

  /** An invited member accepts: true when there was an invitation to accept. */
  async activateInvited(tx: MssqlTx, userId: string): Promise<boolean> {
    const res = await tx
      .updateTable('tenant_members')
      .set({ status: 'active' })
      .where('user_id', '=', userId)
      .where('status', '=', 'invited')
      .executeTakeFirst();
    return Number(res.numUpdatedRows) === 1;
  }

  /** The member fields only the organisation owns. */
  async updateMember(
    tx: MssqlTx,
    userId: string,
    v: Partial<{ idCode: string | null; phoneExtension: string | null }>,
  ): Promise<void> {
    await tx
      .updateTable('tenant_members')
      .set({
        ...(v.idCode !== undefined ? { id_code: v.idCode } : {}),
        ...(v.phoneExtension !== undefined ? { phone_extension: v.phoneExtension } : {}),
      })
      .where('user_id', '=', userId)
      .execute();
  }
}
