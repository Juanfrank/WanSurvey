import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditActions,
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  unique,
  type MssqlTestApp,
  type Session,
} from './harness.js';

/**
 * The organisation and its projects over HTTP, on SQL Server: settings merged, role changes,
 * projects with defaults from the organisation, the codes once, what a project-scoped member sees,
 * logos kept apart from the project, permissions and isolation by organisation. The counterpart of
 * what test/admin.test.ts, test/rbac.test.ts and test/branding.test.ts check on PostgreSQL.
 */
describe.skipIf(!configured)('SQL Server: organisation and projects over HTTP', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let owner: Session;
  let tenantRoute: string;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 7),
  ]);

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    tenantRoute = '/api/v1/tenant';
    owner = await login(t, await createUser(t.owner, tenant.id, [{ role: 'owner' }]), tenant.slug);
  });
  afterAll(async () => {
    await t?.close();
  });

  const post = (s: Session, url: string, body: object) =>
    s.agent.post(url).set('x-csrf-token', s.csrf).send(body);
  const patch = (s: Session, url: string, body: object) =>
    s.agent.patch(url).set('x-csrf-token', s.csrf).send(body);

  it('reads the organisation and merges its settings, keeping what a patch leaves out', async () => {
    const first = await owner.agent.get(tenantRoute);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      slug: tenant.slug,
      plan: 'trial',
      settings: {},
      rolePermissions: {},
    });

    const a = await patch(owner, tenantRoute, {
      settings: { defaultLanguage: 'es', defaultTimezone: 'America/Guatemala' },
    });
    expect(a.status).toBe(200);
    const b = await patch(owner, tenantRoute, {
      name: 'Alfa',
      settings: { defaultLanguage: 'en' },
    });
    expect(b.body).toMatchObject({
      name: 'Alfa',
      settings: { defaultLanguage: 'en', defaultTimezone: 'America/Guatemala' },
    });
    const bad = await patch(owner, tenantRoute, { settings: { defaultTimezone: 'Mars/Olympus' } });
    expect(bad.status).toBe(400);
    expect(await auditActions(t.owner, tenant.id)).toContain('tenant.updated');
  });

  it('keeps what the organisation changed in its roles, as the difference from the defaults', async () => {
    const before = await owner.agent.get(`${tenantRoute}/roles`);
    expect(before.status).toBe(200);
    expect(before.body.roles.length).toBeGreaterThan(3);
    const interviewer = before.body.roles.find((r: { role: string }) => r.role === 'interviewer');
    expect(interviewer.changed).toBe(false);
    const fewer = interviewer.permissions.slice(0, 1);
    const put = await owner.agent
      .put(`${tenantRoute}/roles`)
      .set('x-csrf-token', owner.csrf)
      .send({ overrides: { interviewer: fewer } });
    expect(put.status).toBe(200);
    expect(put.body.roles.find((r: { role: string }) => r.role === 'interviewer')).toMatchObject({
      permissions: fewer,
      changed: true,
    });
    const back = await owner.agent
      .put(`${tenantRoute}/roles`)
      .set('x-csrf-token', owner.csrf)
      .send({ overrides: {} });
    expect(back.body.roles.find((r: { role: string }) => r.role === 'interviewer').changed).toBe(
      false,
    );
    expect(await auditActions(t.owner, tenant.id)).toContain('tenant.roles_updated');
  });

  it('creates projects with the organisation’s defaults, lists them, and keeps codes once', async () => {
    const created = await post(owner, '/api/v1/projects', {
      name: 'Zeta',
      code: 'Z-1',
      modesEnabled: ['CATI'],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Zeta',
      code: 'Z-1',
      status: 'draft',
      timezone: 'America/Guatemala',
      languages: ['en'],
      modesEnabled: ['CATI'],
      logoUpdatedAt: null,
    });
    expect(created.body.settings).toBeTruthy();
    const second = await post(owner, '/api/v1/projects', {
      name: 'Alfa',
      code: 'A-1',
      timezone: 'Europe/Madrid',
      languages: ['es', 'en'],
    });
    expect(second.body).toMatchObject({ timezone: 'Europe/Madrid', languages: ['es', 'en'] });
    const list = await owner.agent.get('/api/v1/projects');
    expect(list.body.map((p: { name: string }) => p.name)).toEqual(['Alfa', 'Zeta']);
    const dup = await post(owner, '/api/v1/projects', { name: 'Otra', code: 'Z-1' });
    expect(dup.status).toBe(409);
    expect(await auditActions(t.owner, tenant.id)).toContain('project.created');
  });

  it('gets, changes and merges the settings of a project, and answers 404 for another’s', async () => {
    const list = await owner.agent.get('/api/v1/projects');
    const zeta = list.body.find((p: { code: string }) => p.code === 'Z-1');
    const got = await owner.agent.get(`/api/v1/projects/${zeta.id}`);
    expect(got.status).toBe(200);
    const upd = await patch(owner, `/api/v1/projects/${zeta.id}`, {
      status: 'active',
      settings: { revealToInterviewers: true },
    });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ status: 'active' });
    expect(upd.body.settings.revealToInterviewers).toBe(true);
    const merged = await patch(owner, `/api/v1/projects/${zeta.id}`, {
      timezone: 'Asia/Tokyo',
      settings: { assignmentMode: 'pool' },
    });
    expect(merged.body.settings).toMatchObject({
      revealToInterviewers: true,
      assignmentMode: 'pool',
    });
    expect(merged.body.timezone).toBe('Asia/Tokyo');
    const other = await createTenant(t.owner);
    const foreign = await createProject(t.owner, other.id);
    expect((await owner.agent.get(`/api/v1/projects/${foreign}`)).status).toBe(404);
    expect((await patch(owner, `/api/v1/projects/${foreign}`, { name: 'x' })).status).toBe(404);
  });

  it('shows a project-scoped member only their projects, and refuses what the role does not allow', async () => {
    const mine = await createProject(t.owner, tenant.id, unique('M'));
    await createProject(t.owner, tenant.id, unique('N'));
    const sup = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'supervisor', projectId: mine }]),
      tenant.slug,
    );
    const seen = await sup.agent.get('/api/v1/projects');
    expect(seen.status).toBe(200);
    expect(seen.body.map((p: { id: string }) => p.id)).toEqual([mine]);
    const none = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]),
      tenant.slug,
    );
    expect((await post(none, '/api/v1/projects', { name: 'X', code: 'X-1' })).status).toBe(403);
    expect((await patch(none, tenantRoute, { name: 'Hack' })).status).toBe(403);
    expect((await none.agent.get(`${tenantRoute}/roles`)).status).toBe(403);
  });

  it('keeps a project’s logo apart from the project, serves it, replaces it and removes it', async () => {
    const list = await owner.agent.get('/api/v1/projects');
    const zeta = list.body.find((p: { code: string }) => p.code === 'Z-1');
    expect((await owner.agent.get(`/api/v1/projects/${zeta.id}/logo`)).status).toBe(404);
    const up = await owner.agent
      .put(`/api/v1/projects/${zeta.id}/logo`)
      .set('x-csrf-token', owner.csrf)
      .attach('file', png, { filename: 'logo.png', contentType: 'image/png' });
    expect(up.status).toBe(200);
    expect(up.body.logoUpdatedAt).toBeTruthy();
    const img = await owner.agent
      .get(`/api/v1/projects/${zeta.id}/logo`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(img.body as Buffer, png)).toBe(0);
    const notImage = await owner.agent
      .put(`/api/v1/projects/${zeta.id}/logo`)
      .set('x-csrf-token', owner.csrf)
      .attach('file', Buffer.from('this is not an image at all'), { filename: 'x.png' });
    expect(notImage.status).toBe(422);
    const gone = await owner.agent
      .delete(`/api/v1/projects/${zeta.id}/logo`)
      .set('x-csrf-token', owner.csrf);
    expect(gone.status).toBe(200);
    expect(gone.body.logoUpdatedAt).toBeNull();
    expect((await owner.agent.get(`/api/v1/projects/${zeta.id}/logo`)).status).toBe(404);
  });

  it('keeps one organisation’s projects out of another’s view', async () => {
    const other = await createTenant(t.owner);
    await createProject(t.owner, other.id, 'ONLY-THERE');
    const list = await owner.agent.get('/api/v1/projects');
    expect(list.body.some((p: { code: string }) => p.code === 'ONLY-THERE')).toBe(false);
  });
});
