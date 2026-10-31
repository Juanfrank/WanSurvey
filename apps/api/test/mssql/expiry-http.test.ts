import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExpiryService } from '../../src/cases/expiry.service.js';
import { setSettings } from './fixtures.js';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
  type TestUser,
} from './harness.js';

const DAY = 86_400_000;

/** Cases expire after their deadline from assignment, on SQL Server (test/expiry.test.ts). */
describe.skipIf(!configured)('SQL Server: cases expire after their deadline', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let interviewer: TestUser;
  let pm: Session;
  let expiry: ExpiryService;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    interviewer = await createUser(t.owner, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]),
      tenant.slug,
    );
    expiry = t.app.get(ExpiryService);
  });
  afterAll(async () => {
    await t?.close();
  });

  async function newCase(opts: { daysAgo: number; status?: string; device?: string }) {
    const id = randomUUID();
    const at = new Date(Date.now() - opts.daysAgo * DAY).toISOString();
    await sql`INSERT INTO cases (id, tenant_id, project_id, external_id, sample, status, assigned_to, assigned_at, checked_out_device)
      VALUES (${id}, ${tenant.id}, ${project}, ${'E' + id.slice(-6)}, '{}',
              ${opts.status ?? 'assigned'}, ${interviewer.id}, CAST(${at} AS datetimeoffset(3)),
              ${opts.device ?? null})`.execute(t.owner);
    return id;
  }
  const row = async (id: string) => {
    const r = (
      (await sql`SELECT status, disposition, assigned_to FROM cases WHERE id = ${id}`.execute(
        t.owner,
      )) as { rows: { status: string; disposition: string | null; assigned_to: string | null }[] }
    ).rows[0]!;
    return r;
  };

  it('closes overdue cases as EXPIRED, leaves the rest, and a supervisor can reopen one', async () => {
    const old = await newCase({ daysAgo: 8 });
    const recent = await newCase({ daysAgo: 2 });
    const onDevice = await newCase({ daysAgo: 9, device: 'device-x' });
    // Without a deadline nothing expires.
    expect(await expiry.expireAll()).toBe(0);

    await setSettings(t.owner, project, { fieldwork: { caseExpiryDays: 7 } });
    expect(await expiry.expireAll()).toBeGreaterThanOrEqual(1);
    expect(await row(old)).toMatchObject({ status: 'finalised', disposition: 'EXPIRED' });
    expect((await row(recent)).status).toBe('assigned');
    expect((await row(onDevice)).status).toBe('assigned');
    const ev = (
      (await sql`SELECT type FROM case_events WHERE case_id = ${old}`.execute(t.owner)) as {
        rows: { type: string }[];
      }
    ).rows[0]!;
    expect(ev.type).toBe('expired');

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
