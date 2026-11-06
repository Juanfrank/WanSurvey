import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppSettingsService } from '../../src/settings/app-settings.service.js';
import { BI_MINUTES_KEY, BiService } from '../../src/stats/bi.service.js';
import {
  auditActions,
  bootstrap,
  configured,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
} from './harness.js';

/** The analysis model's refresh frequency, set for the installation (mssql/0025). */
describe.skipIf(!configured)('SQL Server: refresh frequency of the analysis model', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let admin: Session;
  let pm: Session;
  let settings: AppSettingsService;
  let bi: BiService;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    admin = await login(t, await createUser(t.owner, tenant.id, [{ role: 'admin' }]), tenant.slug);
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]),
      tenant.slug,
    );
    settings = t.app.get(AppSettingsService);
    bi = t.app.get(BiService);
    await settings.set(BI_MINUTES_KEY, null, null);
  });
  afterAll(async () => {
    // The setting is the installation's: leave it as the other suites expect it.
    await settings?.set(BI_MINUTES_KEY, null, null);
    await t?.close();
  });

  const post = (s: Session, body: string | object | undefined) =>
    s.agent.post('/api/v1/app-settings/bi').set('x-csrf-token', s.csrf).send(body);

  it('starts on the deployment schedule', async () => {
    const res = await admin.agent.get('/api/v1/app-settings/bi');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refreshMinutes: null, source: 'deployment', min: 15 });
  });

  it('only whoever manages the organisation sets it, and only to valid values', async () => {
    expect((await post(pm, { refreshMinutes: 60 })).status).toBe(403);
    for (const bad of [5, 10_081, 1.5, '60', undefined])
      expect((await post(admin, { refreshMinutes: bad })).status).toBe(400);
    const ok = await post(admin, { refreshMinutes: 60 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ refreshMinutes: 60, source: 'setting' });
    expect(await auditActions(t.owner, tenant.id)).toContain('app.bi_frequency_changed');
  });

  it('never, and back to the deployment schedule', async () => {
    expect((await post(admin, { refreshMinutes: 0 })).body).toMatchObject({
      refreshMinutes: 0,
      source: 'setting',
    });
    expect(await bi.tick()).toBe(false);
    expect((await post(admin, { refreshMinutes: null })).body).toMatchObject({
      refreshMinutes: null,
      source: 'deployment',
    });
  });

  it('a tick waits for the frequency since the last run', async () => {
    await post(admin, { refreshMinutes: 15 });
    const now = new Date();
    await bi.tick(now); // runs (nothing recorded yet) and records the moment
    expect(await bi.lastRun()).not.toBeNull();
    expect(await bi.tick(new Date(now.getTime() + 5 * 60_000))).toBe(false);
    const res = await admin.agent.get('/api/v1/app-settings/bi');
    expect(res.body.lastRunAt).not.toBeNull();
    await post(admin, { refreshMinutes: null });
  });

  it('refreshes now on request', async () => {
    const res = await admin.agent
      .post('/api/v1/app-settings/bi/refresh')
      .set('x-csrf-token', admin.csrf);
    expect(res.status).toBe(200);
    expect(typeof res.body.ran).toBe('boolean');
    expect(
      (await pm.agent.post('/api/v1/app-settings/bi/refresh').set('x-csrf-token', pm.csrf)).status,
    ).toBe(403);
  });
});
