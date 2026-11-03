import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe.skipIf(!configured)('SQL Server: per-organisation theme', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let owner: Session;
  let interviewer: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    const project = await createProject(t.owner, tenant.id);
    owner = await login(t, await createUser(t.owner, tenant.id, [{ role: 'owner' }]), tenant.slug);
    interviewer = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]),
      tenant.slug,
    );
  });
  afterAll(async () => {
    await t?.close();
  });

  const patch = (s: Session, body: unknown) =>
    s.agent
      .patch('/api/v1/tenant')
      .set('x-csrf-token', s.csrf)
      .send(body as object);

  it('saves a default and an accent from the palette, and everyone of the organisation reads it', async () => {
    const res = await patch(owner, { branding: { theme: { default: 'dark', accent: 'teal' } } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // People without access to the organisation's settings still get its look, with their session.
    expect((await interviewer.agent.get('/api/v1/tenant')).status).toBe(403);
    const me = await interviewer.agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.theme).toEqual({ default: 'dark', accent: 'teal' });
    expect(await auditActions(t.owner, tenant.id)).toContain('tenant.updated');
  });

  it('refuses colours outside the palette and free CSS, and people without the permission', async () => {
    for (const theme of [
      { default: 'light', accent: '#ff0000' },
      { default: 'light', accent: 'red; background:url(x)' },
      { default: 'purple', accent: 'teal' },
    ]) {
      expect((await patch(owner, { branding: { theme } })).status).toBe(400);
    }
    expect((await patch(interviewer, { branding: { theme: { default: 'light' } } })).status).toBe(
      403,
    );
    const read = await owner.agent.get('/api/v1/tenant').expect(200);
    expect(read.body.branding.theme).toEqual({ default: 'dark', accent: 'teal' });
  });

  it('keeps the other branding keys when the theme changes', async () => {
    await patch(owner, { branding: { custom: 'kept' } }).expect(200);
    const res = await patch(owner, { branding: { theme: { default: 'light', accent: 'brand' } } });
    expect(res.status).toBe(200);
    expect(res.body.branding).toMatchObject({
      custom: 'kept',
      theme: { default: 'light', accent: 'brand' },
    });
  });
});
