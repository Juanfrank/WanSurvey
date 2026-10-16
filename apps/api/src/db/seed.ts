import { pathToFileURL } from 'node:url';
import { household, sampleRows } from '@wansurvey/fixtures';
import { compile } from '@wansurvey/logic';
import { Questionnaire, ROLES } from '@wansurvey/schema';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { hashPassword } from '../auth/auth.service.js';
import { PiiCipher } from '../cases/pii.js';

/**
 * Demo organisation "demo" with one user per role (password from SEED_PASSWORD) and a second
 * organisation "demo2" that the project manager also belongs to.
 * The demo project has the household questionnaire, published as version 1, and 50 sample
 * cases; a rule assigns the region 1 cases to the interviewer.
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
                ${['CATI', 'CAPI', 'CAWI', 'PAPI']}, 'America/Lima', ${['es']})`;
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
      const userIds: Partial<Record<(typeof ROLES)[number], string>> = {};
      for (const role of ROLES) {
        const userId = uuidv7();
        userIds[role] = userId;
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
      // Sample dictionary and cases.
      const fields: [string, string, boolean][] = [
        ['first_name', 'text', true],
        ['last_name', 'text', true],
        ['region', 'number', false],
        ['city', 'text', false],
        ['age', 'number', false],
      ];
      for (const [i, [name, type, pii]] of fields.entries()) {
        await tx`insert into sample_fields (id, tenant_id, project_id, name, type, pii, position)
                 values (${uuidv7()}, ${tenantId}, ${projectId}, ${name}, ${type}, ${pii}, ${i})`;
      }
      const interviewer = userIds.interviewer!;
      // Personal fields are sealed (H1) when the encryption key is at hand; otherwise the
      // worker's `pii.encrypt` job seals them.
      const key = process.env.APP_ENCRYPTION_KEY;
      const cipher = key ? new PiiCipher(key) : null;
      const pii = new Set(fields.filter(([, , p]) => p).map(([n]) => n));
      for (const r of sampleRows(50)) {
        const caseId = uuidv7();
        const mine = r.region === 1;
        const sample = {
          first_name: r.first_name,
          last_name: r.last_name,
          region: r.region,
          city: r.city,
          age: r.age,
        };
        const sealed = cipher
          ? cipher.seal(sample, pii)
          : { sample, samplePii: null, samplePiiIndex: null };
        await tx`insert into cases (id, tenant_id, project_id, questionnaire_id, external_id, sample, sample_pii, sample_pii_index, status, priority, assigned_to, assigned_at)
                 values (${caseId}, ${tenantId}, ${projectId}, ${questionnaireId}, ${r.id}, ${tx.json(sealed.sample as never)},
                         ${sealed.samplePii}, ${sealed.samplePiiIndex}, ${mine ? 'assigned' : 'fresh'}, ${r.priority}, ${mine ? interviewer : null},
                         ${mine ? new Date() : null})`;
        await tx`insert into contacts (id, tenant_id, case_id, type, value, label)
                 values (${uuidv7()}, ${tenantId}, ${caseId}, 'phone', ${'+51' + r.phone}, 'phone'),
                        (${uuidv7()}, ${tenantId}, ${caseId}, 'email', ${r.email}, 'email')`;
        await tx`insert into case_events (id, tenant_id, case_id, type, details)
                 values (${uuidv7()}, ${tenantId}, ${caseId}, 'imported', ${tx.json({ seed: true })})`;
      }
      await tx`insert into assignments (id, tenant_id, project_id, user_id, kind, name, filter)
               values (${uuidv7()}, ${tenantId}, ${projectId}, ${interviewer}, 'rule', 'Region 1', 'case.region == 1')`;
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
