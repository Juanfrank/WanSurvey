import { randomUUID } from 'node:crypto';
import { household } from '@wansurvey/fixtures';
import { compile } from '@wansurvey/logic';
import { Questionnaire } from '@wansurvey/schema';
import { uuidv7 } from 'uuidv7';
import { sql } from 'kysely';
import type { MssqlTestApp, Session } from './harness.js';

/**
 * Fixtures for the HTTP tests on SQL Server, written as the database's owner (the counterpart of
 * `createQuestionnaire` and the raw inserts in the PostgreSQL tests). JSON columns are text here.
 */
type Owner = MssqlTestApp['owner'];

/** Inserts a questionnaire (the household sample by default), optionally published as v1. */
export async function createQuestionnaire(
  owner: Owner,
  tenantId: string,
  projectId: string,
  opts: { publish?: boolean; definition?: unknown } = {},
): Promise<string> {
  const id = randomUUID();
  const definition = (opts.definition ?? household) as Record<string, unknown>;
  await sql`INSERT INTO questionnaires (id, tenant_id, project_id, name, draft)
            VALUES (${id}, ${tenantId}, ${projectId}, ${'Q ' + id.slice(-6)}, ${JSON.stringify(definition)})`.execute(
    owner,
  );
  if (opts.publish) {
    const compiled = compile(definition as never);
    await sql`INSERT INTO questionnaire_versions (id, tenant_id, questionnaire_id, version, definition, compiled, hash)
              VALUES (${randomUUID()}, ${tenantId}, ${id}, 1,
                ${JSON.stringify(Questionnaire.parse(definition))}, ${JSON.stringify(compiled)}, ${compiled.hash})`.execute(
      owner,
    );
  }
  return id;
}

/** A case of the project, free or held by `holder`. */
export async function newCase(
  owner: Owner,
  tenantId: string,
  projectId: string,
  opts: {
    holder?: string | null;
    sample?: Record<string, unknown>;
    status?: string;
    questionnaireId?: string | null;
    externalId?: string;
  } = {},
): Promise<string> {
  const id = uuidv7();
  const status = opts.status ?? (opts.holder ? 'assigned' : 'fresh');
  await sql`INSERT INTO cases (id, tenant_id, project_id, questionnaire_id, external_id, sample, status, assigned_to)
            VALUES (${id}, ${tenantId}, ${projectId}, ${opts.questionnaireId ?? null},
              ${opts.externalId ?? 'R' + id.slice(-8)}, ${JSON.stringify(opts.sample ?? {})},
              ${status}, ${opts.holder ?? null})`.execute(owner);
  return id;
}

export const post = (s: Session, path: string, body: object = {}) =>
  s.agent.post(`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);
export const put = (s: Session, path: string, body: object = {}) =>
  s.agent.put(`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);
export const patch = (s: Session, path: string, body: object = {}) =>
  s.agent.patch(`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);
export const get = (s: Session, path: string) => s.agent.get(`/api/v1${path}`);

/** Sets the project's settings document. */
export async function setSettings(owner: Owner, projectId: string, settings: object) {
  await sql`UPDATE projects SET settings = ${JSON.stringify(settings)} WHERE id = ${projectId}`.execute(
    owner,
  );
}

/** A contact of a case (a phone by default). */
export async function newContact(
  owner: Owner,
  tenantId: string,
  caseId: string,
  opts: { type?: string; value?: string; label?: string | null } = {},
) {
  await sql`INSERT INTO contacts (id, tenant_id, case_id, type, value, label)
            VALUES (${randomUUID()}, ${tenantId}, ${caseId}, ${opts.type ?? 'phone'},
              ${opts.value ?? '+51987654321'}, ${opts.label === undefined ? 'Móvil' : opts.label})`.execute(
    owner,
  );
}

const GUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** Rows as the PostgreSQL client gave them: GUIDs in lower case, JSON columns parsed. */
function plain(r: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'string' && GUID.test(v)) out[k] = v.toLowerCase();
    else if (typeof v === 'string' && /^[[{]/.test(v)) {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    } else out[k] = v;
  }
  return out;
}

/**
 * `admin\`select …\`` for the owner connection, like the tagged template the PostgreSQL tests use:
 * the rows come back as plain objects (see `plain`). The SQL itself is T-SQL.
 */
export function ownerQuery(owner: Owner) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const res = (await sql(strings, ...values).execute(owner)) as {
      rows: Record<string, unknown>[];
    };
    return res.rows.map(plain);
  };
}
