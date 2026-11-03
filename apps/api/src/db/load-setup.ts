import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from '@wansurvey/logic';
import { Questionnaire } from '@wansurvey/schema';
import { sql, type Transaction } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { hashPassword } from '../auth/auth.service.js';
import { createMssqlDb } from './mssql/connection.js';

type Tx = Transaction<Record<string, never>>;

/** The questionnaire of the load tests: the same three questions in every mode. */
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

export interface LoadUsers {
  password: string;
  slug: string;
  projectId: string;
  questionnaireId: string;
  questionnaireVersionId: string;
  /** Telephone interviewers: many cases each, all with a phone number. */
  cati: { email: string }[];
  /** Face-to-face interviewers: a few cases each, to download to a tablet. */
  capi: { email: string; caseIds: string[] }[];
}

export interface LoadOptions {
  cati: number;
  capi: number;
  catiCases: number;
  capiCases: number;
  password: string;
  slug: string;
}

const CHUNK = 100;

/**
 * Data for the k6 load tests (`load/README.md`) on a migrated database: an organisation with a
 * project fielded in CATI, CAPI and CAWI, a three-question questionnaire, an open link to it,
 * telephone interviewers with a pile of cases each and face-to-face interviewers with a few. The
 * accounts are ordinary ones (password sign-in); nothing here turns a protection off.
 */
export async function loadSetup(adminUrl: string, o: LoadOptions): Promise<LoadUsers> {
  const db = createMssqlDb<Record<string, never>>(adminUrl, { max: 1, requestTimeoutMs: 0 });
  try {
    const stamp = Date.now().toString(36);
    const tenantId = uuidv7();
    const projectId = uuidv7();
    const questionnaireId = uuidv7();
    const versionId = uuidv7();
    const def = Questionnaire.parse(definition);
    const compiled = compile(def);
    const hash = await hashPassword(o.password);
    const out: LoadUsers = {
      password: o.password,
      slug: o.slug,
      projectId,
      questionnaireId,
      questionnaireVersionId: versionId,
      cati: [],
      capi: [],
    };
    const settings = {
      assignmentMode: 'assigned',
      cati: { callingHours: { from: '00:00', to: '00:00' }, maxAttempts: 3 },
    };
    await db.transaction().execute(async (tx: Tx) => {
      const run = async (q: ReturnType<typeof sql>) => void (await q.execute(tx));
      // The link of an earlier run must not keep the name.
      await run(sql`DELETE FROM open_links WHERE slug = ${o.slug}`);
      await run(
        sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, ${'Carga ' + stamp}, ${'load-' + stamp})`,
      );
      await run(sql`INSERT INTO projects (id, tenant_id, name, code, status, modes_enabled, timezone, languages, settings)
                    VALUES (${projectId}, ${tenantId}, 'Carga', ${'LOAD' + stamp}, 'active',
                            ${JSON.stringify(['CATI', 'CAPI', 'CAWI'])}, 'America/Lima', ${JSON.stringify(['es'])},
                            ${JSON.stringify(settings)})`);
      await run(sql`INSERT INTO questionnaires (id, tenant_id, project_id, name, draft)
                    VALUES (${questionnaireId}, ${tenantId}, ${projectId}, 'Carga', ${JSON.stringify(def)})`);
      await run(sql`INSERT INTO questionnaire_versions (id, tenant_id, questionnaire_id, version, definition, compiled, hash)
                    VALUES (${versionId}, ${tenantId}, ${questionnaireId}, 1, ${JSON.stringify(def)},
                            ${JSON.stringify(compiled)}, ${compiled.hash})`);
      await run(sql`INSERT INTO open_links (id, tenant_id, project_id, questionnaire_id, slug)
                    VALUES (${uuidv7()}, ${tenantId}, ${projectId}, ${questionnaireId}, ${o.slug})`);

      const caseRows: { id: string; user: string; ext: string; phone: boolean }[] = [];
      const people = [
        ...Array.from({ length: o.cati }, (_, i) => ({ kind: 'cati' as const, i })),
        ...Array.from({ length: o.capi }, (_, i) => ({ kind: 'capi' as const, i })),
      ];
      for (const p of people) {
        const userId = uuidv7();
        const email = `load.${p.kind}.${stamp}.${p.i}@example.org`;
        await run(sql`INSERT INTO users (id, email, name, first_name, status, password_hash)
                      VALUES (${userId}, ${email}, ${`Carga ${p.kind} ${p.i}`}, 'Carga', 'active', ${hash})`);
        await run(
          sql`INSERT INTO tenant_members (id, tenant_id, user_id, status) VALUES (${uuidv7()}, ${tenantId}, ${userId}, 'active')`,
        );
        await run(
          sql`INSERT INTO memberships (id, tenant_id, user_id, role, project_id) VALUES (${uuidv7()}, ${tenantId}, ${userId}, 'interviewer', ${projectId})`,
        );
        const n = p.kind === 'cati' ? o.catiCases : o.capiCases;
        const ids: string[] = [];
        for (let c = 0; c < n; c++) {
          const id = uuidv7();
          ids.push(id);
          caseRows.push({
            id,
            user: userId,
            ext: `${p.kind === 'cati' ? 'T' : 'F'}${p.i}-${c}`,
            phone: p.kind === 'cati',
          });
        }
        if (p.kind === 'cati') out.cati.push({ email });
        else out.capi.push({ email, caseIds: ids });
      }
      for (let i = 0; i < caseRows.length; i += CHUNK) {
        const part = caseRows.slice(i, i + CHUNK);
        await run(sql`INSERT INTO cases (id, tenant_id, project_id, questionnaire_id, external_id, sample, status, assigned_to, assigned_at) VALUES
          ${sql.join(
            part.map(
              (r) =>
                sql`(${r.id}, ${tenantId}, ${projectId}, ${questionnaireId}, ${r.ext}, ${JSON.stringify({ city: 'Lima' })}, 'assigned', ${r.user}, SYSDATETIMEOFFSET())`,
            ),
          )}`);
        const phones = part.filter((r) => r.phone);
        if (phones.length)
          await run(sql`INSERT INTO contacts (id, tenant_id, case_id, type, value, label) VALUES
            ${sql.join(
              phones.map(
                (r, k) =>
                  sql`(${uuidv7()}, ${tenantId}, ${r.id}, 'phone', ${'+519' + String(10_000_000 + i + k).slice(-8)}, 'Móvil')`,
              ),
            )}`);
      }
    });
    return out;
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
  const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
  const options: LoadOptions = {
    cati: num('LOAD_CATI_USERS', 50),
    capi: num('LOAD_CAPI_USERS', 150),
    catiCases: num('LOAD_CATI_CASES', 200),
    capiCases: num('LOAD_CAPI_CASES', 10),
    password: process.env.LOAD_PASSWORD ?? 'load-password-123',
    slug: process.env.LOAD_SLUG ?? 'load-open',
  };
  loadSetup(admin, options)
    .then((users) => {
      const file = resolve(process.cwd(), process.env.LOAD_USERS_FILE ?? '../../load/users.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(users));
      console.log(
        `Load data ready: ${users.cati.length} CATI and ${users.capi.length} CAPI interviewers, ` +
          `open link "${users.slug}". Users written to ${file}.`,
      );
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
