import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newCase } from './fixtures.js';
import {
  auditActions,
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
} from './harness.js';

const DAY = 86_400_000;

/** The integration API: keys made by owners, read only, inside one organisation (ADR 0001). */
describe.skipIf(!configured)('SQL Server: integration API keys', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let projectA: string;
  let projectB: string;
  let owner: Session;
  let admin: Session;
  const http = () => request(t.app.getHttpServer());
  const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

  async function makeKey(body: Record<string, unknown> = {}, s: Session = owner) {
    const res = await s.agent
      .post('/api/v1/api-keys')
      .set('x-csrf-token', s.csrf)
      .send({
        name: 'Power BI',
        scopes: ['projects:read', 'cases:read', 'interviews:read'],
        expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
        ...body,
      });
    return res;
  }

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    projectA = await createProject(t.owner, tenant.id);
    projectB = await createProject(t.owner, tenant.id);
    await sql`INSERT INTO sample_fields (id, tenant_id, project_id, name, type, pii)
              VALUES (${randomUUID()}, ${tenant.id}, ${projectA}, 'name', 'text', 1),
                     (${randomUUID()}, ${tenant.id}, ${projectA}, 'region', 'text', 0)`.execute(
      t.owner,
    );
    await newCase(t.owner, tenant.id, projectA, {
      sample: { name: 'Rosa Quispe', region: 'Norte' },
      externalId: 'C1',
    });
    await newCase(t.owner, tenant.id, projectA, { externalId: 'C2' });
    await newCase(t.owner, tenant.id, projectB, { externalId: 'C3' });
    owner = await login(t, await createUser(t.owner, tenant.id, [{ role: 'owner' }]), tenant.slug);
    admin = await login(t, await createUser(t.owner, tenant.id, [{ role: 'admin' }]), tenant.slug);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('is made by owners only, shows the key once and stores only a hash', async () => {
    expect((await makeKey({}, admin)).status).toBe(403);
    const res = await makeKey();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.key).toMatch(/^wsk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    const list = await owner.agent.get('/api/v1/api-keys');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(
      // The secret is base64url and may itself hold underscores: everything after the key id.
      (res.body.key as string).split('_').slice(2).join('_'),
    );
    const row = list.body.find((k: { id: string }) => k.id === res.body.id);
    expect(row).toMatchObject({ name: 'Power BI', revokedAt: null, lastUsedAt: null });
    const [stored] = (
      (await sql`SELECT secret_hash FROM api_keys WHERE id = ${res.body.id}`.execute(t.owner)) as {
        rows: { secret_hash: string }[];
      }
    ).rows;
    expect(stored!.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await auditActions(t.owner, tenant.id)).toContain('apikey.created');
  });

  it('refuses a key that lasts more than a year, none, or a bad address', async () => {
    expect(
      (await makeKey({ expiresAt: new Date(Date.now() + 400 * DAY).toISOString() })).status,
    ).toBe(400);
    expect((await makeKey({ expiresAt: new Date(Date.now() - DAY).toISOString() })).status).toBe(
      400,
    );
    expect((await makeKey({ allowedIps: ['not-an-ip'] })).status).toBe(400);
    expect((await makeKey({ scopes: [] })).status).toBe(400);
    expect((await makeKey({ scopes: ['pii:read'] })).status).toBe(400);
  });

  it('reads with a bearer key, without cookie or CSRF', async () => {
    const { body } = await makeKey();
    const projects = await http().get('/api/v1/ext/v1/projects').set(bearer(body.key));
    expect(projects.status, JSON.stringify(projects.body)).toBe(200);
    expect(projects.body.data.map((p: { id: string }) => p.id).sort()).toEqual(
      [projectA, projectB].sort(),
    );
    const cases = await http()
      .get(`/api/v1/ext/v1/projects/${projectA}/cases`)
      .set(bearer(body.key));
    expect(cases.status, JSON.stringify(cases.body)).toBe(200);
    expect(cases.body.data).toHaveLength(2);
    const c1 = cases.body.data.find((c: { externalId: string }) => c.externalId === 'C1');
    // The personal field is masked, the other is not.
    expect(c1.sample.name).not.toBe('Rosa Quispe');
    expect(c1.sample.region).toBe('Norte');
    expect(JSON.stringify(cases.body)).not.toContain('Quispe');
    const first = await http()
      .get(`/api/v1/ext/v1/projects/${projectA}/cases`)
      .query({ limit: 1 })
      .set(bearer(body.key));
    expect(first.body.data).toHaveLength(1);
    expect(first.body.next).toBeTruthy();
    const second = await http()
      .get(`/api/v1/ext/v1/projects/${projectA}/cases`)
      .query({ limit: 1, after: first.body.next })
      .set(bearer(body.key));
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(second.body.next).toBeNull();
    const interviews = await http()
      .get(`/api/v1/ext/v1/projects/${projectA}/interviews`)
      .set(bearer(body.key));
    expect(interviews.status).toBe(200);
    expect(interviews.body.data).toEqual([]);
    // It is recorded that the key was used.
    await new Promise((r) => setTimeout(r, 300));
    const list = await owner.agent.get('/api/v1/api-keys');
    expect(list.body.find((k: { id: string }) => k.id === body.id).lastUsedAt).not.toBeNull();
  });

  it('answers 401 without a valid key and never takes a cookie as one', async () => {
    expect((await http().get('/api/v1/ext/v1/projects')).status).toBe(401);
    expect(
      (
        await http()
          .get('/api/v1/ext/v1/projects')
          .set(bearer('wsk_000000000000_' + 'a'.repeat(43)))
      ).status,
    ).toBe(401);
    expect(
      (await http().get('/api/v1/ext/v1/projects').set({ Authorization: 'Bearer nope' })).status,
    ).toBe(401);
    // A signed-in person's cookie is not a key.
    expect((await owner.agent.get('/api/v1/ext/v1/projects')).status).toBe(401);
    // And a key is not a session: the web app's routes do not take it.
    const { body } = await makeKey();
    expect((await http().get('/api/v1/projects').set(bearer(body.key))).status).toBe(401);
    expect((await http().get('/api/v1/api-keys').set(bearer(body.key))).status).toBe(401);
  });

  it('checks the scope', async () => {
    const { body } = await makeKey({ scopes: ['projects:read'] });
    expect((await http().get('/api/v1/ext/v1/projects').set(bearer(body.key))).status).toBe(200);
    const denied = await http()
      .get(`/api/v1/ext/v1/projects/${projectA}/cases`)
      .set(bearer(body.key));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('MISSING_SCOPE');
    expect((await http().get('/api/v1/ext/v1/audit-log').set(bearer(body.key))).status).toBe(403);
  });

  it('stops at revocation and at expiry', async () => {
    const { body } = await makeKey();
    expect((await http().get('/api/v1/ext/v1/projects').set(bearer(body.key))).status).toBe(200);
    expect(
      (await owner.agent.delete(`/api/v1/api-keys/${body.id}`).set('x-csrf-token', owner.csrf))
        .status,
    ).toBe(204);
    expect((await http().get('/api/v1/ext/v1/projects').set(bearer(body.key))).status).toBe(401);
    expect(
      (await owner.agent.delete(`/api/v1/api-keys/${body.id}`).set('x-csrf-token', owner.csrf))
        .status,
    ).toBe(404);
    expect(await auditActions(t.owner, tenant.id)).toContain('apikey.revoked');

    const old = await makeKey();
    await sql`UPDATE api_keys SET expires_at = DATEADD(day, -1, SYSDATETIMEOFFSET()) WHERE id = ${old.body.id}`.execute(
      t.owner,
    );
    expect((await http().get('/api/v1/ext/v1/projects').set(bearer(old.body.key))).status).toBe(
      401,
    );
  });

  it('honours the list of allowed addresses', async () => {
    const here = await makeKey({ allowedIps: ['127.0.0.1', '::1'] });
    expect((await http().get('/api/v1/ext/v1/projects').set(bearer(here.body.key))).status).toBe(
      200,
    );
    const range = await makeKey({ allowedIps: ['127.0.0.0/8'] });
    expect((await http().get('/api/v1/ext/v1/projects').set(bearer(range.body.key))).status).toBe(
      200,
    );
    const elsewhere = await makeKey({ allowedIps: ['10.0.0.0/8'] });
    expect(
      (await http().get('/api/v1/ext/v1/projects').set(bearer(elsewhere.body.key))).status,
    ).toBe(401);
  });

  it('keeps a project key inside its project', async () => {
    const { body } = await makeKey({
      projectId: projectB,
      scopes: ['projects:read', 'cases:read', 'audit:read'],
    });
    const projects = await http().get('/api/v1/ext/v1/projects').set(bearer(body.key));
    expect(projects.body.data.map((p: { id: string }) => p.id)).toEqual([projectB]);
    expect(
      (await http().get(`/api/v1/ext/v1/projects/${projectA}/cases`).set(bearer(body.key))).status,
    ).toBe(404);
    const own = await http().get(`/api/v1/ext/v1/projects/${projectB}/cases`).set(bearer(body.key));
    expect(own.body.data.map((c: { externalId: string }) => c.externalId)).toEqual(['C3']);
    expect((await http().get('/api/v1/ext/v1/audit-log').set(bearer(body.key))).status).toBe(403);
  });

  it('never reaches another organisation', async () => {
    const other = await createTenant(t.owner);
    const otherProject = await createProject(t.owner, other.id);
    const { body } = await makeKey();
    expect(
      (await http().get(`/api/v1/ext/v1/projects/${otherProject}/cases`).set(bearer(body.key)))
        .status,
    ).toBe(404);
    const o2 = await login(t, await createUser(t.owner, other.id, [{ role: 'owner' }]), other.slug);
    expect((await o2.agent.get('/api/v1/api-keys')).body).toEqual([]);
    expect(
      (await o2.agent.delete(`/api/v1/api-keys/${body.id}`).set('x-csrf-token', o2.csrf)).status,
    ).toBe(404);
  });

  it('reads the activity log with the audit scope', async () => {
    const { body } = await makeKey({ scopes: ['audit:read'] });
    const res = await http()
      .get('/api/v1/ext/v1/audit-log')
      .query({ action: 'apikey.created' })
      .set(bearer(body.key));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((r: { action: string }) => r.action === 'apikey.created')).toBe(
      true,
    );
  });
});
