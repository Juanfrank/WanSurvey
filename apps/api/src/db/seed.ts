import { pathToFileURL } from 'node:url';
import { ROLES } from '@wansurvey/schema';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { hashPassword } from '../auth/auth.service.js';

/**
 * Demo tenant "demo" with one user per role (password from SEED_PASSWORD) and one project.
 * Owners and admins enrol TOTP on first login. Idempotent: does nothing if the tenant exists.
 */
export async function seed(adminUrl: string, password: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const [existing] = await sql`select id from tenants where slug = 'demo'`;
    if (existing) {
      console.log('Demo tenant already exists; nothing to do');
      return;
    }
    const tenantId = uuidv7();
    const projectId = uuidv7();
    const hash = await hashPassword(password);
    await sql.begin(async (tx) => {
      await tx`insert into tenants (id, name, slug) values (${tenantId}, 'Demo Research', 'demo')`;
      await tx`
        insert into projects (id, tenant_id, name, code, status, modes_enabled, timezone, languages)
        values (${projectId}, ${tenantId}, 'Household Survey 2026', 'HH2026', 'active',
                ${['CATI', 'CAPI', 'CAWI', 'PAPI']}, 'America/Lima', ${['en', 'es']})`;
      for (const role of ROLES) {
        const userId = uuidv7();
        const email = `${role.replace('_', '.')}@demo.wansurvey.test`;
        await tx`
          insert into users (id, tenant_id, email, name, first_name, status, password_hash)
          values (${userId}, ${tenantId}, ${email}, ${`Demo ${role}`}, ${role}, 'active', ${hash})`;
        await tx`insert into memberships (id, tenant_id, user_id, role) values (${uuidv7()}, ${tenantId}, ${userId}, ${role})`;
        console.log(`  ${role.padEnd(16)} ${email}`);
      }
    });
    console.log(`Seeded tenant "demo" (log in with organisation "demo" and the SEED_PASSWORD)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const admin = process.env.DATABASE_ADMIN_URL;
  if (!admin) {
    console.error('DATABASE_ADMIN_URL is required');
    process.exit(1);
  }
  seed(admin, process.env.SEED_PASSWORD ?? 'demo-password-123').catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
