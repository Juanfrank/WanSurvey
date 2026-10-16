import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExpiryService } from '../src/cases/expiry.service.js';
import {
  bootstrap,
  createProject,
  createTenant,
  createUser,
  login,
  type Session,
  type TestApp,
  type TestUser,
} from './harness.js';

const DAY = 86_400_000;

describe('cases expire after their deadline from assignment', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let interviewer: TestUser;
  let pm: Session;
  let expiry: ExpiryService;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    interviewer = await createUser(t.admin, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    pm = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]));
    expiry = t.app.get(ExpiryService);
  });
  afterAll(() => t.close());

  async function newCase(opts: { daysAgo: number; status?: string; device?: string }) {
    const id = uuidv7();
    await t.admin`insert into cases (id, tenant_id, project_id, external_id, sample, status, assigned_to, assigned_at, checked_out_device)
      values (${id}, ${tenant.id}, ${project}, ${'E' + id.slice(-6)}, ${t.admin.json({})},
              ${opts.status ?? 'assigned'}, ${interviewer.id}, ${new Date(Date.now() - opts.daysAgo * DAY)},
              ${opts.device ?? null})`;
    return id;
  }
  const row = async (id: string) =>
    (await t.admin`select status, disposition, assigned_to from cases where id = ${id}`)[0]!;

  it('closes overdue cases as EXPIRED, leaves the rest, and a supervisor can reopen one', async () => {
    const old = await newCase({ daysAgo: 8 });
    const recent = await newCase({ daysAgo: 2 });
    const onDevice = await newCase({ daysAgo: 9, device: 'device-x' });
    // Without a deadline nothing expires.
    expect(await expiry.expireAll()).toBe(0);

    await t.admin`update projects set settings = ${t.admin.json({ fieldwork: { caseExpiryDays: 7 } })} where id = ${project}`;
    expect(await expiry.expireAll()).toBeGreaterThanOrEqual(1);
    expect(await row(old)).toMatchObject({ status: 'finalised', disposition: 'EXPIRED' });
    expect((await row(recent)).status).toBe('assigned');
    expect((await row(onDevice)).status).toBe('assigned');
    const [ev] = await t.admin`select type from case_events where case_id = ${old}`;
    expect(ev!.type).toBe('expired');

    // The list says when the others expire.
    const list = await pm.agent.get(`/api/v1/projects/${project}/cases`);
    expect(list.body.caseExpiryDays).toBe(7);

    const reopen = await pm.agent
      .patch(`/api/v1/projects/${project}/cases/${old}`)
      .set('x-csrf-token', pm.csrf)
      .send({ status: 'fresh' });
    expect(reopen.status, JSON.stringify(reopen.body)).toBe(200);
    expect(await row(old)).toMatchObject({ status: 'fresh', disposition: null, assigned_to: null });
  });
});
