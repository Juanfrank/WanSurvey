import { pathToFileURL } from 'node:url';
import { household, sampleRows } from '@wansurvey/fixtures';
import { compile } from '@wansurvey/logic';
import { Questionnaire, ROLES } from '@wansurvey/schema';
import { sql, type Transaction } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { hashPassword } from '../auth/auth.service.js';
import { PiiCipher } from '../cases/pii.js';
import { createMssqlDb } from './mssql/connection.js';

type Tx = Transaction<Record<string, never>>;

/** An instant as SQL Server takes it (see db/mssql/instant.ts). */
export const at = (d: Date) => sql`CAST(${d.toISOString()} AS datetimeoffset(3))`;

/**
 * Demo organisation "demo" with one user per role (password from SEED_PASSWORD) and a second
 * organisation "demo2" that the project manager also belongs to.
 * The demo project has the household questionnaire, published as version 1, and 50 sample
 * cases; a rule assigns the region 1 cases to the interviewer.
 * Owners and admins enrol TOTP on first login. Idempotent: does nothing if the tenant exists.
 */
export async function seed(adminUrl: string, password: string): Promise<void> {
  const db = createMssqlDb<Record<string, never>>(adminUrl, { max: 1, requestTimeoutMs: 0 });
  try {
    const existing = await sql`SELECT id FROM tenants WHERE slug = 'demo'`.execute(db);
    if (existing.rows.length) {
      console.log('Demo tenant already exists; nothing to do');
      return;
    }
    const tenantId = uuidv7();
    const otherTenantId = uuidv7();
    const projectId = uuidv7();
    const hash = await hashPassword(password);
    await db.transaction().execute(async (tx: Tx) => {
      const run = async (q: ReturnType<typeof sql>) => void (await q.execute(tx));
      await run(
        sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Demo Research', 'demo')`,
      );
      await run(
        sql`INSERT INTO tenants (id, name, slug) VALUES (${otherTenantId}, 'Second Agency', 'demo2')`,
      );
      await run(sql`
        INSERT INTO projects (id, tenant_id, name, code, status, modes_enabled, timezone, languages)
        VALUES (${projectId}, ${tenantId}, 'Household Survey 2026', 'HH2026', 'active',
                ${JSON.stringify(['CATI', 'CAPI', 'CAWI', 'PAPI'])}, 'America/Lima', ${JSON.stringify(['es'])})`);
      await run(sql`
        INSERT INTO projects (id, tenant_id, name, code, status)
        VALUES (${uuidv7()}, ${otherTenantId}, 'Business Panel', 'BIZ', 'active')`);
      const questionnaireId = uuidv7();
      const definition = Questionnaire.parse(household);
      const compiled = compile(definition);
      await run(sql`
        INSERT INTO questionnaires (id, tenant_id, project_id, name, draft)
        VALUES (${questionnaireId}, ${tenantId}, ${projectId}, 'Household questionnaire',
                ${JSON.stringify(definition)})`);
      await run(sql`
        INSERT INTO questionnaire_versions
          (id, tenant_id, questionnaire_id, version, definition, compiled, hash)
        VALUES (${uuidv7()}, ${tenantId}, ${questionnaireId}, 1, ${JSON.stringify(definition)},
                ${JSON.stringify(compiled)}, ${compiled.hash})`);
      const member = async (tenant: string, user: string) =>
        run(
          sql`INSERT INTO tenant_members (id, tenant_id, user_id, status) VALUES (${uuidv7()}, ${tenant}, ${user}, 'active')`,
        );
      const membership = async (tenant: string, user: string, role: string) =>
        run(
          sql`INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (${uuidv7()}, ${tenant}, ${user}, ${role})`,
        );
      const userIds: Partial<Record<(typeof ROLES)[number], string>> = {};
      for (const role of ROLES) {
        const userId = uuidv7();
        userIds[role] = userId;
        const email = `${role.replace('_', '.')}@demo.wansurvey.test`;
        await run(sql`
          INSERT INTO users (id, email, name, first_name, status, password_hash)
          VALUES (${userId}, ${email}, ${`Demo ${role}`}, ${role}, 'active', ${hash})`);
        await member(tenantId, userId);
        await membership(tenantId, userId, role);
        if (role === 'project_manager') {
          // Same account in a second organisation, to try switching.
          await member(otherTenantId, userId);
          await membership(otherTenantId, userId, 'supervisor');
        }
        console.log(`  ${role.padEnd(16)} ${email}`);
      }
      // A second interviewer who mostly keys paper forms (interviewers also key them).
      const clerkId = uuidv7();
      await run(sql`
        INSERT INTO users (id, email, name, first_name, status, password_hash)
        VALUES (${clerkId}, 'data.entry@demo.wansurvey.test', 'Demo clerk', 'clerk', 'active', ${hash})`);
      await member(tenantId, clerkId);
      await membership(tenantId, clerkId, 'interviewer');
      console.log(`  ${'clerk'.padEnd(16)} data.entry@demo.wansurvey.test`);
      const fields: [string, string, boolean][] = [
        ['first_name', 'text', true],
        ['last_name', 'text', true],
        ['region', 'number', false],
        ['city', 'text', false],
        ['age', 'number', false],
      ];
      for (const [i, [name, type, pii]] of fields.entries()) {
        await run(sql`INSERT INTO sample_fields (id, tenant_id, project_id, name, type, pii, position)
                      VALUES (${uuidv7()}, ${tenantId}, ${projectId}, ${name}, ${type}, ${pii ? 1 : 0}, ${i})`);
      }
      const interviewer = userIds.interviewer!;
      const key = process.env.APP_ENCRYPTION_KEY;
      const cipher = key ? new PiiCipher(key) : null;
      const pii = new Set(fields.filter(([, , p]) => p).map(([n]) => n));
      const now = new Date();
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
        await run(sql`INSERT INTO cases (id, tenant_id, project_id, questionnaire_id, external_id, sample, sample_pii, sample_pii_index, status, priority, assigned_to, assigned_at)
                      VALUES (${caseId}, ${tenantId}, ${projectId}, ${questionnaireId}, ${r.id}, ${JSON.stringify(sealed.sample)},
                              ${sealed.samplePii}, ${sealed.samplePiiIndex ? JSON.stringify(sealed.samplePiiIndex) : null},
                              ${mine ? 'assigned' : 'fresh'}, ${r.priority}, ${mine ? interviewer : null},
                              ${mine ? at(now) : null})`);
        await run(sql`INSERT INTO contacts (id, tenant_id, case_id, type, value, label)
                      VALUES (${uuidv7()}, ${tenantId}, ${caseId}, 'phone', ${'+51' + r.phone}, 'phone'),
                             (${uuidv7()}, ${tenantId}, ${caseId}, 'email', ${r.email}, 'email')`);
        await run(sql`INSERT INTO case_events (id, tenant_id, case_id, type, details)
                      VALUES (${uuidv7()}, ${tenantId}, ${caseId}, 'imported', ${JSON.stringify({ seed: true })})`);
      }
      await run(sql`INSERT INTO assignments (id, tenant_id, project_id, user_id, kind, name, filter)
                    VALUES (${uuidv7()}, ${tenantId}, ${projectId}, ${interviewer}, 'rule', 'Region 1', 'case.region == 1')`);
    });
    console.log(
      'Seeded organisations "demo" and "demo2" (log in with the e-mail and SEED_PASSWORD).',
    );
    console.log('project.manager@demo.wansurvey.test belongs to both.');
  } finally {
    await db.destroy();
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
