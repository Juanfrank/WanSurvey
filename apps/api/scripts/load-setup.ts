/**
 * Data for the k6 load tests (load/README.md), on a database already migrated: an
 * organisation with a two-question questionnaire (AGE, SAT), an open link `load-open` to it,
 * and N interviewers, each with one case assigned. Writes `load/sync-users.json` for
 * sync-300.js. Run from apps/api: `DATABASE_ADMIN_URL=… tsx scripts/load-setup.ts [N]`.
 */
import { writeFileSync } from 'node:fs';
import { compile } from '@wansurvey/logic';
import { Questionnaire } from '@wansurvey/schema';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { hashPassword } from '../src/auth/auth.service.js';

const N = Number(process.argv[2] ?? 300);
const PASSWORD = process.env.LOAD_PASSWORD ?? 'load-password-123';
const SLUG = 'load-open';

const definition = {
  id: 'LOAD',
  title: { es: 'Carga' },
  defaultLanguage: 'es',
  languages: ['es'],
  sections: [
    {
      id: 'S',
      title: { es: 'S' },
      items: [
        { kind: 'question', id: 'AGE', name: 'AGE', type: 'numeric', text: { es: '¿Edad?' } },
        {
          kind: 'question',
          id: 'SAT',
          name: 'SAT',
          type: 'scale',
          text: { es: '¿Qué tan satisfecho está?' },
          scale: { style: 'likert', min: 1, max: 5 },
        },
        {
          kind: 'question',
          id: 'COMMENTS',
          name: 'COMMENTS',
          type: 'text',
          text: { es: 'Comentarios' },
          required: false,
        },
      ],
    },
  ],
};

const sql = postgres(process.env.DATABASE_ADMIN_URL!, { max: 4, onnotice: () => {} });
const stamp = Date.now().toString(36);
const tenantId = uuidv7();
const projectId = uuidv7();
const questionnaireId = uuidv7();

await sql`delete from open_links where slug = ${SLUG}`;
await sql`insert into tenants (id, name, slug) values (${tenantId}, ${'Carga ' + stamp}, ${'load-' + stamp})`;
await sql`insert into projects (id, tenant_id, name, code) values (${projectId}, ${tenantId}, 'Carga', ${'LOAD' + stamp})`;
await sql`insert into questionnaires (id, tenant_id, project_id, name, draft)
          values (${questionnaireId}, ${tenantId}, ${projectId}, 'Carga', ${sql.json(definition as never)})`;
const compiled = compile(Questionnaire.parse(definition));
await sql`insert into questionnaire_versions (id, tenant_id, questionnaire_id, version, definition, compiled, hash)
          values (${uuidv7()}, ${tenantId}, ${questionnaireId}, 1,
                  ${sql.json(Questionnaire.parse(definition) as never)}, ${sql.json(compiled as never)}, ${compiled.hash})`;
await sql`insert into open_links (id, tenant_id, project_id, questionnaire_id, slug)
          values (${uuidv7()}, ${tenantId}, ${projectId}, ${questionnaireId}, ${SLUG})`;

const hash = await hashPassword(PASSWORD);
const users: { email: string; projectId: string; caseId: string; questionnaireId: string }[] = [];
for (let i = 0; i < N; i++) {
  const userId = uuidv7();
  const caseId = uuidv7();
  const email = `load.${stamp}.${i}@example.org`;
  await sql`insert into users (id, email, name, status, password_hash)
            values (${userId}, ${email}, ${'Entrevistador ' + i}, 'active', ${hash})`;
  await sql`insert into tenant_members (id, tenant_id, user_id, status)
            values (${uuidv7()}, ${tenantId}, ${userId}, 'active')`;
  await sql`insert into memberships (id, tenant_id, user_id, role, project_id)
            values (${uuidv7()}, ${tenantId}, ${userId}, 'interviewer', ${projectId})`;
  await sql`insert into cases (id, tenant_id, project_id, questionnaire_id, external_id, status, assigned_to, assigned_at)
            values (${caseId}, ${tenantId}, ${projectId}, ${questionnaireId}, ${'C' + i}, 'assigned', ${userId}, now())`;
  users.push({ email, projectId, caseId, questionnaireId });
}
writeFileSync(new URL('../../../load/sync-users.json', import.meta.url), JSON.stringify(users));
console.log(
  `Organisation ${tenantId}, project ${projectId}, open link ${SLUG}, ${N} interviewers.`,
);
await sql.end();
