import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { createMssqlDb } from './mssql/connection.js';
import { sqlName } from './mssql/migrate.js';

/** The organisation's name and slug made from the domain of the first administrator's UPN. */
export function organisationFor(upn: string): { name: string; slug: string } {
  const domain = upn.slice(upn.lastIndexOf('@') + 1).toLowerCase();
  const slug =
    domain
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 60) || 'main';
  return { name: domain, slug };
}

export type InitialAdminOutcome = 'created' | 'present' | 'ignored';

/**
 * A new installation has no organisation and nobody who could create one. INITIAL_ADMIN_USER, the
 * user principal name (UPN) of the first administrator in Microsoft Entra ID, starts it: when the
 * database has no organisation at all, one is created from the UPN's domain (named after it,
 * Microsoft sign-in on for that domain, through the deployment's directory), with that person as
 * its owner, invited. Their first Microsoft sign-in activates the account: there is no password.
 *
 * It does nothing when the person already exists, and when the installation already has
 * organisations (then it is only said, so the setting is not mistaken for a way in).
 */
export async function ensureInitialAdmin(
  adminUrl: string,
  upn: string,
  directory: { entraTenantId: string; clientId: string },
  schema = 'dbo',
): Promise<InitialAdminOutcome> {
  // The owner's own default schema is dbo whatever the application's is, so the tables are named.
  const T = (name: string) => sql.raw(`${sqlName('The schema', schema)}.${name}`);
  const email = upn.trim().toLowerCase();
  const org = organisationFor(email);
  const db = createMssqlDb<Record<string, never>>(adminUrl, { max: 1, requestTimeoutMs: 0 });
  try {
    return await db.transaction().execute(async (tx) => {
      // Two instances starting together: one at a time, and the second finds it done.
      await sql`DECLARE @r int;
        EXEC @r = sp_getapplock @Resource = N'wansurvey.initial-admin', @LockMode = N'Exclusive',
          @LockOwner = N'Transaction', @LockTimeout = 60000;
        IF @r < 0 THROW 50003, 'Could not take the initial administrator lock', 1;`.execute(tx);
      const known = await sql<{
        id: string;
      }>`SELECT id FROM ${T('users')} WHERE email = ${email}`.execute(tx);
      if (known.rows.length) return 'present';
      const orgs = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${T('tenants')}`.execute(tx);
      if (Number(orgs.rows[0]!.n) > 0) return 'ignored';
      const tenantId = uuidv7();
      const userId = uuidv7();
      await sql`INSERT INTO ${T('tenants')} (id, name, slug) VALUES (${tenantId}, ${org.name}, ${org.slug})`.execute(
        tx,
      );
      await sql`
        INSERT INTO ${T('tenant_sso')} (tenant_id, entra_tenant_id, client_id, client_secret_enc, enabled, allowed_domains)
        VALUES (${tenantId}, ${directory.entraTenantId.toLowerCase()}, ${directory.clientId.toLowerCase()}, NULL, 1,
                ${JSON.stringify([org.name])})`.execute(tx);
      await sql`
        INSERT INTO ${T('users')} (id, email, name, status, password_hash)
        VALUES (${userId}, ${email}, ${email}, 'pending', NULL)`.execute(tx);
      await sql`INSERT INTO ${T('tenant_members')} (id, tenant_id, user_id, status) VALUES (${uuidv7()}, ${tenantId}, ${userId}, 'invited')`.execute(
        tx,
      );
      await sql`INSERT INTO ${T('memberships')} (id, tenant_id, user_id, role) VALUES (${uuidv7()}, ${tenantId}, ${userId}, 'owner')`.execute(
        tx,
      );
      return 'created';
    });
  } finally {
    await db.destroy();
  }
}
