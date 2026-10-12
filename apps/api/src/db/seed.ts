import { pathToFileURL } from 'node:url';
import { household } from '@wansurvey/fixtures';
import { compile } from '@wansurvey/logic';
import { Questionnaire, ROLES } from '@wansurvey/schema';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { hashPassword } from '../auth/auth.service.js';

/**
 * Demo organisation "demo" with one user per role (password from SEED_PASSWORD) and a second
 * organisation "demo2" that the project manager also belongs to.
 * The demo project has the household questionnaire, published as version 1.
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
    const otherTenantId = uuidv7();
    const projectId = uuidv7();
    const hash = await hashPassword(password);
    await sql.begin(async (tx) => {
      await tx`insert into tenants (id, name, slug) values (${tenantId}, 'Demo Research', 'demo')`;
      await tx`insert into tenants (id, name, slug) values (${otherTenantId}, 'Second Agency', 'demo2')`;
      await tx`
        insert into projects (id, tenant_id, name, code, status, modes_enabled, timezone, languages)
        values (${projectId}, ${tenantId}, 'Household Survey 2026', 'HH2026', 'active',
                ${['CATI', 'CAPI', 'CAWI', 'PAPI']}, 'America/Lima', ${['en', 'es']})`;
      await tx`
        insert into projects (id, tenant_id, name, code, status)
        values (${uuidv7()}, ${otherTenantId}, 'Business Panel', 'BIZ', 'active')`;
      const questionnaireId = uuidv7();
      const definition = Questionnaire.parse(household);
      const compiled = compile(definition);
      await tx`
        insert into questionnaires (id, tenant_id, project_id, name, draft)
        values (${questionnaireId}, ${tenantId}, ${projectId}, 'Household questionnaire',
                ${tx.json(definition as never)})`;
      await tx`
        insert into questionnaire_versions
          (id, tenant_id, questionnaire_id, version, definition, compiled, hash)
        values (${uuidv7()}, ${tenantId}, ${questionnaireId}, 1, ${tx.json(definition as never)},
                ${tx.json(compiled as never)}, ${compiled.hash})`;
      for (const role of ROLES) {
        const userId = uuidv7();
        const email = `${role.replace('_', '.')}@demo.wansurvey.test`;
        await tx`
          insert into users (id, email, name, first_name, status, password_hash)
          values (${userId}, ${email}, ${`Demo ${role}`}, ${role}, 'active', ${hash})`;
        await tx`insert into tenant_members (id, tenant_id, user_id, status) values (${uuidv7()}, ${tenantId}, ${userId}, 'active')`;
        await tx`insert into memberships (id, tenant_id, user_id, role) values (${uuidv7()}, ${tenantId}, ${userId}, ${role})`;
        if (role === 'project_manager') {
          // Same account in a second organisation, to try switching.
          await tx`insert into tenant_members (id, tenant_id, user_id, status) values (${uuidv7()}, ${otherTenantId}, ${userId}, 'active')`;
          await tx`insert into memberships (id, tenant_id, user_id, role) values (${uuidv7()}, ${otherTenantId}, ${userId}, 'supervisor')`;
        }
        console.log(`  ${role.padEnd(16)} ${email}`);
      }
    });
    console.log(
      'Seeded organisations "demo" and "demo2" (log in with the e-mail and SEED_PASSWORD).',
    );
    console.log('project.manager@demo.wansurvey.test belongs to both.');
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
