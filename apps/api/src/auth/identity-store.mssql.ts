import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { instant } from '../db/mssql/instant.js';
import type { MssqlTx } from '../db/mssql/database.js';

/**
 * What the sign-in service reads and writes beyond sessions and people, on SQL Server (Kysely):
 * second-factor codes that work once, links between an account and an external identity (Entra),
 * and an organisation's Microsoft sign-in settings.
 */
export interface SsoRow {
  tenantId: string;
  entraTenantId: string;
  clientId: string;
  clientSecretEnc: string | null;
  enabled: boolean;
  enforceSso: boolean;
  allowedDomains: string[];
  updatedAt: Date;
}

export interface SsoValues {
  entraTenantId: string;
  clientId: string;
  clientSecretEnc: string | null;
  enabled: boolean;
  enforceSso: boolean;
  allowedDomains: string[];
}

export class IdentityStore {
  /**
   * Accepts a second-factor code's 30-second step once: true for the one call that moves the
   * account's last step forward, also when two codes race (a code seen after use is refused).
   */
  async acceptTotpStep(tx: MssqlTx, userId: string, step: number): Promise<boolean> {
    const res = await sql`
      UPDATE dbo.users SET totp_last_step = ${step}
      WHERE id = ${userId} AND (totp_last_step IS NULL OR totp_last_step < ${step})`.execute(tx);
    return Number(res.numAffectedRows) === 1;
  }

  /** The account's sign-in fields, for checking a password or a code. */
  async credentials(
    tx: MssqlTx,
    userId: string,
  ): Promise<{
    passwordHash: string | null;
    totpSecretEnc: string | null;
    totpEnabled: boolean;
    totpLastStep: number | null;
  } | null> {
    const u = await tx
      .selectFrom('users')
      .select(['password_hash', 'totp_secret_enc', 'totp_enabled', 'totp_last_step'])
      .where('id', '=', userId)
      .executeTakeFirst();
    return u
      ? {
          passwordHash: u.password_hash,
          totpSecretEnc: u.totp_secret_enc,
          totpEnabled: !!u.totp_enabled,
          // bigint comes back as a number or text, depending on its size.
          totpLastStep: u.totp_last_step === null ? null : Number(u.totp_last_step),
        }
      : null;
  }

  // ─── Identity links ─────────────────────────────────────────────────────────────────

  async userByIdentity(tx: MssqlTx, issuer: string, subject: string): Promise<string | null> {
    const r = await tx
      .selectFrom('user_identities')
      .select('user_id')
      .where('issuer', '=', issuer)
      .where('subject', '=', subject)
      .executeTakeFirst();
    return r?.user_id.toLowerCase() ?? null;
  }

  /** Links an external identity to an account; once per issuer and subject. */
  async linkIdentity(
    tx: MssqlTx,
    v: { userId: string; provider: string; issuer: string; subject: string },
  ): Promise<void> {
    await tx
      .insertInto('user_identities')
      .values({
        id: randomUUID(),
        user_id: v.userId,
        provider: v.provider,
        issuer: v.issuer,
        subject: v.subject,
      })
      .execute();
  }

  // ─── An organisation's Microsoft sign-in ──────────────────────────────────────────────

  async sso(tx: MssqlTx, tenantId: string): Promise<SsoRow | null> {
    const r = await tx
      .selectFrom('tenant_sso')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    return r
      ? {
          tenantId: r.tenant_id.toLowerCase(),
          entraTenantId: r.entra_tenant_id,
          clientId: r.client_id,
          clientSecretEnc: r.client_secret_enc,
          enabled: !!r.enabled,
          enforceSso: !!r.enforce_sso,
          allowedDomains: JSON.parse(r.allowed_domains) as string[],
          updatedAt: r.updated_at,
        }
      : null;
  }

  /**
   * One organisation saves its domains at a time (an application lock held to the end of the
   * transaction), so two organisations saving the same domain cannot both get it: call this first,
   * then `domainOwners`.
   */
  async lockSsoDomains(tx: MssqlTx): Promise<void> {
    const res = await sql<{ r: number }>`
      DECLARE @r int;
      EXEC @r = sp_getapplock @Resource = N'sso-domains', @LockMode = N'Exclusive',
        @LockOwner = N'Transaction', @LockTimeout = 10000;
      SELECT @r AS r`.execute(tx);
    if ((res.rows[0]?.r ?? -1) < 0) throw new Error('Could not lock the SSO domains');
  }

  /** The organisations whose enabled Microsoft sign-in claims a domain. */
  async domainOwners(tx: MssqlTx, domain: string): Promise<string[]> {
    const res = await sql<{ tenant_id: string }>`EXEC dbo.sso_tenants_for_domain ${domain}`.execute(
      tx,
    );
    return res.rows.map((r) => r.tenant_id.toLowerCase());
  }

  /** Inserts or replaces the organisation's settings. */
  async saveSso(tx: MssqlTx, tenantId: string, v: SsoValues): Promise<SsoRow> {
    const values = {
      entra_tenant_id: v.entraTenantId,
      client_id: v.clientId,
      client_secret_enc: v.clientSecretEnc,
      enabled: v.enabled,
      enforce_sso: v.enforceSso,
      allowed_domains: JSON.stringify(v.allowedDomains),
      updated_at: instant(new Date()),
    };
    const updated = await tx
      .updateTable('tenant_sso')
      .set(values)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0)
      await tx
        .insertInto('tenant_sso')
        .values({ tenant_id: tenantId, ...values })
        .execute();
    return (await this.sso(tx, tenantId))!;
  }
}
