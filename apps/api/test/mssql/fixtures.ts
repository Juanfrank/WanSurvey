import { randomUUID } from 'node:crypto';
import { household } from '@wansurvey/fixtures';
import { compile } from '@wansurvey/logic';
import { Questionnaire } from '@wansurvey/schema';
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
  const id = randomUUID();
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
