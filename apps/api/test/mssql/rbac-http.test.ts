import { randomUUID } from 'node:crypto';
import { ROLES, roleHasPermission, type Permission, type Role } from '@wansurvey/schema';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../../src/config.js';
import { createQuestionnaire } from './fixtures.js';
import {
  PASSWORD,
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
} from './harness.js';

interface Ids {
  project: string;
  target: string;
  /** A questionnaire of `project` with v1 published and its draft unchanged. */
  questionnaire: string;
  /** A fresh questionnaire for calls that change it. */
  fresh(opts?: { publish?: boolean }): Promise<string>;
  /** Adds a scenario to a questionnaire and returns its id. */
  scenario(questionnaireId: string): Promise<string>;
  /** A case of `project`. */
  caseId: string;
  /** An interviewer of the tenant (eligible for assignments). */
  interviewerId: string;
  /** A fresh assignment rule; returns its id. */
  rule(): Promise<string>;
  /** A fresh, uncommitted import with one staged row; returns its id. */
  importId(): Promise<string>;
}

interface Endpoint {
  name: string;
  /** Any one of these is enough. */
  permission: Permission | Permission[];
  call(s: Session, ids: Ids): request.Test | Promise<request.Response>;
}

/** Every protected endpoint with the permission it requires. */
const ENDPOINTS: Endpoint[] = [
  { name: 'GET /users', permission: 'users.read', call: (s) => s.agent.get('/api/v1/users') },
  {
    name: 'POST /users/invite',
    permission: 'users.manage',
    call: (s) =>
      s.agent
        .post('/api/v1/users/invite')
        .set('x-csrf-token', s.csrf)
        .send({
          email: `inv-${Math.random().toString(36).slice(2)}@example.org`,
          name: 'X',
          memberships: [{ role: 'client_viewer' }],
        }),
  },
  {
    name: 'PUT /users/:id/memberships',
    permission: 'users.manage',
    call: (s, ids) =>
      s.agent
        .put(`/api/v1/users/${ids.target}/memberships`)
        .set('x-csrf-token', s.csrf)
        .send({ memberships: [{ role: 'client_viewer' }] }),
  },
  {
    name: 'POST /users/:id/force-logout',
    permission: 'users.manage',
    call: (s, ids) =>
      s.agent.post(`/api/v1/users/${ids.target}/force-logout`).set('x-csrf-token', s.csrf),
  },
  {
    name: 'GET /projects/:id/people',
    permission: ['users.read', 'projects.update'],
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/people`),
  },
  {
    name: 'GET /tenant/roles',
    permission: 'tenant.read',
    call: (s) => s.agent.get('/api/v1/tenant/roles'),
  },
  {
    name: 'GET papi scans',
    permission: ['dataentry.key', 'cases.read_all'],
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/papi/scans`),
  },
  { name: 'GET /tenant', permission: 'tenant.read', call: (s) => s.agent.get('/api/v1/tenant') },
  {
    name: 'PATCH /tenant',
    permission: 'tenant.manage',
    call: (s) =>
      s.agent
        .patch('/api/v1/tenant')
        .set('x-csrf-token', s.csrf)
        .send({ settings: { defaultLanguage: 'es' } }),
  },
  {
    name: 'GET /tenant/sso',
    permission: 'tenant.manage',
    call: (s) => s.agent.get('/api/v1/tenant/sso'),
  },
  {
    name: 'PUT /tenant/sso',
    permission: 'tenant.manage',
    call: (s) =>
      s.agent.put('/api/v1/tenant/sso').set('x-csrf-token', s.csrf).send({
        entraTenantId: '00000000-0000-4000-8000-000000000001',
        clientId: '00000000-0000-4000-8000-000000000002',
        enabled: false,
      }),
  },
  {
    name: 'GET /projects',
    permission: 'projects.read',
    call: (s) => s.agent.get('/api/v1/projects'),
  },
  {
    name: 'POST /projects',
    permission: 'projects.create',
    call: (s) =>
      s.agent
        .post('/api/v1/projects')
        .set('x-csrf-token', s.csrf)
        .send({ name: 'P', code: `C${Math.random().toString(36).slice(2, 10)}` }),
  },
  {
    name: 'GET /projects/:id',
    permission: 'projects.read',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}`),
  },
  {
    name: 'PATCH /projects/:id',
    permission: 'projects.update',
    call: (s, ids) =>
      s.agent
        .patch(`/api/v1/projects/${ids.project}`)
        .set('x-csrf-token', s.csrf)
        .send({ timezone: 'America/Lima' }),
  },
  {
    name: 'GET /audit-log',
    permission: 'audit.read',
    call: (s) => s.agent.get('/api/v1/audit-log'),
  },
  {
    name: 'GET questionnaires',
    permission: 'questionnaires.read',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/questionnaires`),
  },
  {
    name: 'POST questionnaires',
    permission: 'questionnaires.edit',
    call: (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/questionnaires`)
        .set('x-csrf-token', s.csrf)
        .send({ name: 'New', modes: ['CAPI'] }),
  },
  {
    name: 'GET questionnaire',
    permission: 'questionnaires.read',
    call: (s, ids) =>
      s.agent.get(`/api/v1/projects/${ids.project}/questionnaires/${ids.questionnaire}`),
  },
  {
    name: 'PUT questionnaire draft',
    permission: 'questionnaires.edit',
    call: async (s, ids) =>
      s.agent
        .put(`/api/v1/projects/${ids.project}/questionnaires/${await ids.fresh()}/draft`)
        .set('x-csrf-token', s.csrf)
        .send({ definition: { id: 'X' }, baseRevision: 1 }),
  },
  {
    name: 'GET questionnaire versions',
    permission: 'questionnaires.read',
    call: (s, ids) =>
      s.agent.get(`/api/v1/projects/${ids.project}/questionnaires/${ids.questionnaire}/versions`),
  },
  {
    name: 'GET questionnaire version',
    permission: 'questionnaires.read',
    call: (s, ids) =>
      s.agent.get(`/api/v1/projects/${ids.project}/questionnaires/${ids.questionnaire}/versions/1`),
  },
  {
    name: 'POST publish-check',
    permission: 'questionnaires.publish',
    call: (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/questionnaires/${ids.questionnaire}/publish-check`)
        .set('x-csrf-token', s.csrf)
        .send({}),
  },
  {
    name: 'POST publish',
    permission: 'questionnaires.publish',
    call: async (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/questionnaires/${await ids.fresh()}/publish`)
        .set('x-csrf-token', s.csrf)
        .send({ baseRevision: 1 }),
  },
  {
    name: 'POST retire version',
    permission: 'questionnaires.publish',
    call: async (s, ids) =>
      s.agent
        .post(
          `/api/v1/projects/${ids.project}/questionnaires/${await ids.fresh({ publish: true })}/versions/1/retire`,
        )
        .set('x-csrf-token', s.csrf),
  },
  {
    name: 'POST questionnaire state',
    permission: 'questionnaires.publish',
    call: async (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/questionnaires/${await ids.fresh()}/state`)
        .set('x-csrf-token', s.csrf)
        .send({ state: 'disabled' }),
  },
  {
    name: 'GET scenarios',
    permission: 'questionnaires.read',
    call: (s, ids) =>
      s.agent.get(`/api/v1/projects/${ids.project}/questionnaires/${ids.questionnaire}/scenarios`),
  },
  {
    name: 'PUT scenario',
    permission: 'questionnaires.edit',
    call: (s, ids) =>
      s.agent
        .put(`/api/v1/projects/${ids.project}/questionnaires/${ids.questionnaire}/scenarios`)
        .set('x-csrf-token', s.csrf)
        .send({ scenario: { name: 'rbac', mode: 'CATI', steps: [] } }),
  },
  {
    name: 'DELETE scenario',
    permission: 'questionnaires.edit',
    call: async (s, ids) => {
      const qid = await ids.fresh();
      const sid = await ids.scenario(qid);
      return s.agent
        .delete(`/api/v1/projects/${ids.project}/questionnaires/${qid}/scenarios/${sid}`)
        .set('x-csrf-token', s.csrf);
    },
  },
  {
    name: 'POST interviews/sync',
    permission: ['interviews.conduct', 'dataentry.key'],
    call: (s) =>
      s.agent
        .post('/api/v1/interviews/sync')
        .set('x-csrf-token', s.csrf)
        .send({ deviceId: 'device-rbac-0001', interviews: [] }),
  },
  {
    name: 'POST cati/next',
    permission: 'interviews.conduct',
    call: (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/cati/next`)
        .set('x-csrf-token', s.csrf)
        .send({}),
  },
  {
    name: 'GET cati/callbacks',
    permission: 'interviews.conduct',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/cati/callbacks`),
  },
  {
    name: 'POST capi/checkout',
    permission: 'interviews.conduct',
    call: (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/capi/checkout`)
        .set('x-csrf-token', s.csrf)
        .send({ deviceId: 'device-rbac-0001', caseIds: [ids.caseId] }),
  },
  {
    name: 'POST capi/checkin',
    permission: 'interviews.conduct',
    call: (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/capi/checkin`)
        .set('x-csrf-token', s.csrf)
        .send({ deviceId: 'device-rbac-0001', caseIds: [ids.caseId] }),
  },
  {
    name: 'POST force-release',
    permission: 'cases.assign',
    call: (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/cases/${ids.caseId}/force-release`)
        .set('x-csrf-token', s.csrf),
  },
  {
    name: 'GET waves',
    permission: 'cawi.waves',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/waves`),
  },
  {
    name: 'GET email-templates',
    permission: ['email.templates', 'cawi.waves'],
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/email-templates`),
  },
  {
    name: 'GET suppressions',
    permission: 'cawi.waves',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/suppressions`),
  },
  {
    name: 'GET papi/mismatches',
    permission: 'interviews.review',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/papi/mismatches`),
  },
  {
    name: 'GET review/queue',
    permission: ['interviews.review', 'interviews.approve'],
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/review/queue`),
  },
  {
    name: 'GET coding',
    permission: ['interviews.correct', 'interviews.review'],
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/coding`),
  },
  {
    name: 'GET metrics/interviewers',
    permission: ['metrics.team', 'metrics.own'],
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/metrics/interviewers`),
  },
  {
    name: 'GET live/snapshot',
    permission: 'dashboards.read',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/live/snapshot`),
  },
  {
    name: 'GET topline',
    permission: 'dashboards.read',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/topline`),
  },
  {
    name: 'GET exports',
    permission: 'exports.run',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/exports`),
  },
  {
    name: 'GET share-links',
    permission: 'projects.update',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/share-links`),
  },
  {
    name: 'GET cases',
    permission: ['cases.read_all', 'cases.read_assigned'],
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/cases`),
  },
  {
    name: 'PATCH case',
    permission: 'cases.edit',
    call: (s, ids) =>
      s.agent
        .patch(`/api/v1/projects/${ids.project}/cases/${ids.caseId}`)
        .set('x-csrf-token', s.csrf)
        .send({ priority: 1 }),
  },
  {
    name: 'POST cases/assign',
    permission: 'cases.assign',
    call: (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/cases/assign`)
        .set('x-csrf-token', s.csrf)
        .send({ caseIds: [], userId: null }),
  },
  {
    name: 'GET assignees',
    permission: 'cases.assign',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/assignees`),
  },
  {
    name: 'GET assignments',
    permission: 'cases.assign',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/assignments`),
  },
  {
    name: 'POST assignments',
    permission: 'cases.assign',
    call: (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/assignments`)
        .set('x-csrf-token', s.csrf)
        .send({ userId: ids.interviewerId, filter: 'case.region == 9', active: false }),
  },
  {
    name: 'PATCH assignment',
    permission: 'cases.assign',
    call: async (s, ids) =>
      s.agent
        .patch(`/api/v1/projects/${ids.project}/assignments/${await ids.rule()}`)
        .set('x-csrf-token', s.csrf)
        .send({ quota: 3 }),
  },
  {
    name: 'DELETE assignment',
    permission: 'cases.assign',
    call: async (s, ids) =>
      s.agent
        .delete(`/api/v1/projects/${ids.project}/assignments/${await ids.rule()}`)
        .set('x-csrf-token', s.csrf),
  },
  {
    name: 'POST assignments/preview',
    permission: 'cases.assign',
    call: (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/assignments/preview`)
        .set('x-csrf-token', s.csrf)
        .send({ filter: 'case.region == 1' }),
  },
  {
    name: 'POST assignments/apply',
    permission: 'cases.assign',
    call: (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/assignments/apply`)
        .set('x-csrf-token', s.csrf)
        .send({}),
  },
  {
    name: 'GET sample-fields',
    permission: ['cases.read_all', 'cases.read_assigned', 'questionnaires.read'],
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/sample-fields`),
  },
  {
    name: 'PUT sample-field',
    permission: 'cases.edit',
    call: (s, ids) =>
      s.agent
        .put(`/api/v1/projects/${ids.project}/sample-fields/region`)
        .set('x-csrf-token', s.csrf)
        .send({ label: 'Region' }),
  },
  {
    name: 'POST imports',
    permission: 'cases.import',
    call: (s, ids) =>
      s.agent
        .post(`/api/v1/projects/${ids.project}/imports`)
        .set('x-csrf-token', s.csrf)
        .attach('file', Buffer.from('id,region\nX1,1\n'), 'x.csv'),
  },
  {
    name: 'GET imports',
    permission: 'cases.import',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}/imports`),
  },
  {
    name: 'GET import',
    permission: 'cases.import',
    call: async (s, ids) =>
      s.agent.get(`/api/v1/projects/${ids.project}/imports/${await ids.importId()}`),
  },
  {
    name: 'PUT import mapping',
    permission: 'cases.import',
    call: async (s, ids) =>
      s.agent
        .put(`/api/v1/projects/${ids.project}/imports/${await ids.importId()}/mapping`)
        .set('x-csrf-token', s.csrf)
        .send({
          columns: [{ kind: 'externalId' }, { kind: 'sample', field: 'region', type: 'number' }],
        }),
  },
];

/**
 * Every protected endpoint against every role, over HTTP on SQL Server: a role without the
 * permission gets 403 and one with it gets through (the counterpart of test/rbac.test.ts, which
 * checks the same matrix on PostgreSQL). It also reaches every controller on the other engine.
 */
describe.skipIf(!configured)('SQL Server: role-based access control', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let otherProject: string;
  let questionnaire: string;
  let caseId: string;
  let interviewerId: string;
  const sessions = new Map<Role, Session>();
  const run = (q: ReturnType<typeof sql>) => q.execute(t.owner);

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    otherProject = await createProject(t.owner, tenant.id);
    questionnaire = await createQuestionnaire(t.owner, tenant.id, project, { publish: true });
    caseId = randomUUID();
    await run(
      sql`INSERT INTO cases (id, tenant_id, project_id, external_id, sample)
          VALUES (${caseId}, ${tenant.id}, ${project}, 'C1', '{"region":1}')`,
    );
    await run(
      sql`INSERT INTO sample_fields (id, tenant_id, project_id, name, type)
          VALUES (${randomUUID()}, ${tenant.id}, ${project}, 'region', 'number')`,
    );
    interviewerId = (await createUser(t.owner, tenant.id, [{ role: 'interviewer' }])).id;
    for (const role of ROLES) {
      const user = await createUser(t.owner, tenant.id, [{ role }]);
      sessions.set(role, await login(t, user, tenant.slug));
    }
  });
  afterAll(async () => {
    await t?.close();
  });

  const ids = (target: string): Ids => ({
    project,
    target,
    questionnaire,
    fresh: (opts) => createQuestionnaire(t.owner, tenant.id, project, opts),
    caseId,
    interviewerId,
    async rule() {
      const id = randomUUID();
      await run(
        sql`INSERT INTO assignments (id, tenant_id, project_id, user_id, kind, filter, active)
            VALUES (${id}, ${tenant.id}, ${project}, ${interviewerId}, 'rule', 'case.region == 9', 0)`,
      );
      return id;
    },
    async importId() {
      const id = randomUUID();
      await run(
        sql`INSERT INTO sample_imports (id, tenant_id, project_id, file_name, size, sha256, headers, rows)
            VALUES (${id}, ${tenant.id}, ${project}, 'x.csv', 10, 'x', '["id","region"]', 1)`,
      );
      await run(
        sql`INSERT INTO sample_import_rows (tenant_id, import_id, row_no, data)
            VALUES (${tenant.id}, ${id}, 1, '["X9","2"]')`,
      );
      return id;
    },
    async scenario(qid) {
      const sid = randomUUID();
      await run(
        sql`INSERT INTO questionnaire_scenarios (id, tenant_id, questionnaire_id, name, scenario)
            VALUES (${sid}, ${tenant.id}, ${qid}, 'x', '{"name":"x","mode":"CATI","steps":[]}')`,
      );
      return sid;
    },
  });

  const cases = ROLES.flatMap((role) => ENDPOINTS.map((e) => ({ role, endpoint: e })));

  it.each(cases)('$role → $endpoint.name', async ({ role, endpoint }) => {
    const target = await createUser(t.owner, tenant.id, [{ role: 'client_viewer' }]);
    const res = await endpoint.call(sessions.get(role)!, ids(target.id));
    const wanted = Array.isArray(endpoint.permission) ? endpoint.permission : [endpoint.permission];
    if (wanted.some((p) => roleHasPermission(role, p))) {
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
    } else {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
  });

  it('every endpoint requires a session', async () => {
    const anon = { agent: request.agent(t.app.getHttpServer()), csrf: 'x' } as unknown as Session;
    for (const e of ENDPOINTS) {
      const res = await e.call(anon, ids(project));
      expect(res.status, e.name).toBe(401);
    }
  });

  describe('project-scoped roles', () => {
    let supervisor: Session;
    let manager: Session;

    beforeAll(async () => {
      supervisor = await login(
        t,
        await createUser(t.owner, tenant.id, [{ role: 'supervisor', projectId: project }]),
        tenant.slug,
      );
      manager = await login(
        t,
        await createUser(t.owner, tenant.id, [{ role: 'project_manager', projectId: project }]),
        tenant.slug,
      );
    });

    it('see and act only within their project', async () => {
      expect((await supervisor.agent.get(`/api/v1/projects/${project}`)).status).toBe(200);
      expect((await supervisor.agent.get(`/api/v1/projects/${otherProject}`)).status).toBe(403);
      const list = await supervisor.agent.get('/api/v1/projects');
      expect(list.body.map((p: { id: string }) => p.id)).toEqual([project]);
      expect(
        (
          await supervisor.agent
            .patch(`/api/v1/projects/${project}`)
            .set('x-csrf-token', supervisor.csrf)
            .send({ timezone: 'UTC' })
        ).status,
      ).toBe(403);

      expect(
        (
          await manager.agent
            .patch(`/api/v1/projects/${project}`)
            .set('x-csrf-token', manager.csrf)
            .send({ timezone: 'UTC' })
        ).status,
      ).toBe(200);
      expect(
        (
          await manager.agent
            .patch(`/api/v1/projects/${otherProject}`)
            .set('x-csrf-token', manager.csrf)
            .send({ timezone: 'UTC' })
        ).status,
      ).toBe(403);
    });

    it('cannot use tenant-level endpoints through a project role', async () => {
      expect(
        (
          await manager.agent
            .post('/api/v1/projects')
            .set('x-csrf-token', manager.csrf)
            .send({ name: 'x', code: 'SCOPED' })
        ).status,
      ).toBe(403);
      expect((await supervisor.agent.get('/api/v1/users')).status).toBe(403);
    });
  });

  it('tenants never see each other through the API', async () => {
    const other = await createTenant(t.owner);
    const otherAdmin = await createUser(t.owner, other.id, [{ role: 'admin' }]);
    const s = await login(t, otherAdmin, other.slug);
    expect((await s.agent.get(`/api/v1/projects/${project}`)).status).toBe(404);
    const users = await s.agent.get('/api/v1/users');
    expect(users.body.map((u: { id: string }) => u.id)).toEqual([otherAdmin.id]);
    const audit = await s.agent.get('/api/v1/audit-log');
    expect(
      audit.body.every((a: { tenantId: string }) => a.tenantId.toLowerCase() === other.id),
    ).toBe(true);
  });

  it('admins can filter the audit log', async () => {
    const s = sessions.get('admin')!;
    const res = await s.agent
      .get('/api/v1/audit-log')
      .query({ action: 'project.created', limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((r: { action: string }) => r.action === 'project.created')).toBe(true);
  });
});

describe.skipIf(!configured)('SQL Server: rate limiting', () => {
  it('limits login attempts per client', async () => {
    process.env.LOGIN_RATE_LIMIT = '3';
    resetConfigCache();
    const t = await bootstrap();
    try {
      const tenant = await createTenant(t.owner);
      const user = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await request(t.app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: PASSWORD });
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await t.close();
      process.env.LOGIN_RATE_LIMIT = '1000';
      resetConfigCache();
    }
  });
});
