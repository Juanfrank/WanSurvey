import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { sampleTable, toCsv } from '@wansurvey/fixtures';
import { ROLE_PERMISSIONS } from '@wansurvey/schema';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NominatimGeocoder } from '../../src/geo/geocoder.js';
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

/** A stand-in for Nominatim's /search: knows two streets, fails on "boom". */
async function mockNominatim() {
  const seen: { q: string; agent: string; at: number }[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url!, 'http://x');
    const q = url.searchParams.get('q') ?? '';
    seen.push({ q, agent: String(req.headers['user-agent']), at: Date.now() });
    if (q.includes('boom')) {
      res.writeHead(503).end();
      return;
    }
    const known: Record<string, [string, string]> = {
      'av. arequipa 100, lima': ['-12.0700', '-77.0350'],
      'jr. cusco 5, cusco': ['-13.5170', '-71.9780'],
    };
    const hit = known[q.toLowerCase()];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hit ? [{ lat: hit[0], lon: hit[1], addresstype: 'house' }] : []));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}

/** Duplicates across projects, geocoding and the case map over HTTP on SQL Server (test/geo.test.ts). */
describe.skipIf(!configured)('SQL Server: geocoding, the case map and duplicates', () => {
  let t: MssqlTestApp;
  let mock: Awaited<ReturnType<typeof mockNominatim>>;
  let tenant: { id: string; slug: string };
  let projectA: string;
  let projectB: string;
  let pm: Session;
  let supervisor: Session;
  let interviewer: TestUser;
  let interviewerS: Session;

  beforeAll(async () => {
    mock = await mockNominatim();
    t = await bootstrap({ geocoder: new NominatimGeocoder(mock.url, 'ops@example.org', 100) });
    tenant = await createTenant(t.owner);
    projectA = await createProject(t.owner, tenant.id, 'Panel A');
    projectB = await createProject(t.owner, tenant.id, 'Panel B');
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]),
      tenant.slug,
    );
    supervisor = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'supervisor' }]),
      tenant.slug,
    );
    interviewer = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
    interviewerS = await login(t, interviewer, tenant.slug);
  });
  afterAll(async () => {
    await t?.close();
    await mock?.close();
  });

  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;
  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(path).set('x-csrf-token', s.csrf).send(body);
  async function importInto(project: string, table: string[][]) {
    const base = `/api/v1/projects/${project}`;
    const up = await pm.agent
      .post(`${base}/imports`)
      .set('x-csrf-token', pm.csrf)
      .attach('file', Buffer.from(toCsv(table)), 'sample.csv');
    const report = await pm.agent
      .put(`${base}/imports/${up.body.id}/mapping`)
      .set('x-csrf-token', pm.csrf)
      .send({ ...up.body.suggested, defaultCountryCode: '51' });
    return { id: up.body.id as string, report: report.body };
  }

  it('flags phones and e-mails already in another project, without blocking', async () => {
    const table = sampleTable(4);
    const first = await importInto(projectA, table);
    expect((await post(pm, `/api/v1/projects/${projectA}/imports/${first.id}/commit`)).status).toBe(
      200,
    );
    // Project B gets two of the same households under other ids, and two new ones.
    const again = sampleTable(4).map((r, i) => (i === 0 ? r : [`B${r[0]}`, ...r.slice(1)]));
    again[3]![6] = '999111222';
    again[3]![7] = 'new3@example.org';
    again[4]![6] = '999111223';
    again[4]![7] = 'new4@example.org';
    const second = await importInto(projectB, again);
    const issue = second.report.issues.find(
      (i: { code: string }) => i.code === 'duplicate_elsewhere',
    );
    expect(issue).toMatchObject({ count: 2, blocking: false });
    expect(issue.examples.map((e: { row: number }) => e.row)).toEqual([1, 2]);
    expect(issue.examples[0]).toMatchObject({ column: 'Panel A', value: '' });
    expect(second.report.elsewhere).toEqual([{ projectId: projectA, name: 'Panel A', rows: 2 }]);
    expect(second.report.valid).toBe(4);
    const done = await post(pm, `/api/v1/projects/${projectB}/imports/${second.id}/commit`);
    expect(done.body).toMatchObject({ created: 4 });

    const [c] = await rows(
      sql`SELECT id FROM cases WHERE project_id = ${projectB} AND external_id = ${'B' + table[1]![0]}`,
    );
    c!.id = (c!.id as string).toLowerCase();
    const detail = await supervisor.agent.get(`/api/v1/projects/${projectB}/cases/${c!.id}`);
    expect(detail.body.elsewhere).toEqual([{ projectId: projectA, name: 'Panel A', cases: 1 }]);
    await post(supervisor, `/api/v1/projects/${projectB}/cases/assign`, {
      caseIds: [c!.id],
      userId: interviewer.id,
    });
    const mine = await interviewerS.agent.get(`/api/v1/projects/${projectB}/cases/${c!.id}`);
    expect(mine.body.elsewhere).toEqual([]);
  });

  it('geocodes addresses in the background and shows them as points', async () => {
    const ids = (
      await rows(sql`SELECT id FROM cases WHERE project_id = ${projectA} ORDER BY external_id`)
    ).map((r) => (r.id as string).toLowerCase());
    const addresses = ['Av. Arequipa 100, Lima', 'Jr. Cusco 5, Cusco', 'Nowhere 1', 'boom'];
    for (const [i, value] of addresses.entries())
      await sql`INSERT INTO contacts (id, tenant_id, case_id, type, value)
        VALUES (${randomUUID()}, ${tenant.id}, ${ids[i]!}, 'address', ${value})`.execute(t.owner);
    const base = `/api/v1/projects/${projectA}`;
    expect((await post(supervisor, `${base}/geocode`)).status).toBe(403);
    const started = await post(pm, `${base}/geocode`);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(started.body).toMatchObject({ running: true, total: 4 });
    expect((await post(pm, `${base}/geocode`)).body.code).toBe('GEOCODE_RUNNING');
    await expect
      .poll(async () => (await pm.agent.get(`${base}/geocode/status`)).body.job.running, {
        timeout: 5000,
      })
      .toBe(false);
    const status = await pm.agent.get(`${base}/geocode/status`);
    expect(status.body).toMatchObject({
      enabled: true,
      job: { total: 4, done: 4, found: 2, notFound: 1, failed: 1 },
    });
    // Nothing left to do: the failed one is tried again next time.
    expect((await post(pm, `${base}/geocode`)).body.total).toBe(1);

    const points = await supervisor.agent.get(`${base}/cases-map`);
    expect(points.body).toHaveLength(2);
    expect(points.body[0]).toEqual({
      caseId: expect.any(String),
      externalId: expect.any(String),
      status: expect.any(String),
      lat: expect.any(Number),
      lng: expect.any(Number),
      quality: 'house',
    });
    expect(JSON.stringify(points.body)).not.toContain('Arequipa');
    const viewed = await rows(sql`SELECT details FROM audit_log
      WHERE target_id = ${projectA} AND action = 'cases.map_viewed'`);
    expect(viewed.map((a) => JSON.parse(a.details as string))).toEqual([{ points: 2 }]);
    // Coordinates locate the person: none without `pii.view`.
    await sql`UPDATE tenants SET role_permissions = ${JSON.stringify({
      supervisor: ROLE_PERMISSIONS.supervisor.filter((p) => p !== 'pii.view'),
    })} WHERE id = ${tenant.id}`.execute(t.owner);
    try {
      expect((await supervisor.agent.get(`${base}/cases-map`)).status).toBe(403);
    } finally {
      await sql`UPDATE tenants SET role_permissions = '{}' WHERE id = ${tenant.id}`.execute(
        t.owner,
      );
    }
    // The interviewer sees only the points of their cases (none here).
    expect((await interviewerS.agent.get(`${base}/cases-map`)).body).toEqual([]);

    // In the drawer, coordinates come with the address: masked until revealed.
    const masked = await supervisor.agent.get(`${base}/cases/${ids[0]}`);
    const addr = masked.body.contacts.find((x: { type: string }) => x.type === 'address');
    expect(addr).toMatchObject({ value: '•••', lat: null, lng: null });
    const shown = await supervisor.agent.get(`${base}/cases/${ids[0]}`).query({ reveal: 'pii' });
    expect(shown.body.contacts.find((x: { type: string }) => x.type === 'address')).toMatchObject({
      value: 'Av. Arequipa 100, Lima',
      lat: -12.07,
      geocodeQuality: 'house',
    });
    const audit = await rows(
      sql`SELECT details FROM audit_log WHERE action = 'cases.geocoded' AND target_id = ${projectA} ORDER BY at, id`,
    );
    expect(JSON.parse(audit[0]!.details as string)).toEqual({ addresses: 4, service: 'nominatim' });
  });

  it('refuses to geocode when no geocoder is set up', async () => {
    const plain = await bootstrap();
    const s = await login(
      plain,
      await createUser(plain.owner, tenant.id, [{ role: 'project_manager' }]),
      tenant.slug,
    );
    const res = await s.agent
      .post(`/api/v1/projects/${projectA}/geocode`)
      .set('x-csrf-token', s.csrf)
      .send({});
    expect(res.body.code).toBe('GEOCODER_OFF');
    expect((await s.agent.get(`/api/v1/projects/${projectA}/geocode/status`)).body).toEqual({
      enabled: false,
      job: null,
    });
    await plain.close();
  });
});
