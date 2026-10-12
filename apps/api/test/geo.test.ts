import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sampleTable, toCsv } from '@wansurvey/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NominatimGeocoder, normaliseAddress } from '../src/geo/geocoder.js';
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

describe('Nominatim geocoder', () => {
  it('identifies itself, spaces requests, caches by address and reports errors', async () => {
    const mock = await mockNominatim();
    const g = new NominatimGeocoder(mock.url, 'ops@example.org', 200);
    const [a, b] = await Promise.all([g.geocode('Av. Arequipa 100, Lima'), g.geocode('Nowhere 1')]);
    expect(a).toEqual({ lat: -12.07, lng: -77.035, quality: 'house' });
    expect(b).toBeNull();
    expect(await g.geocode('av.  arequipa 100 lima')).toEqual(a);
    expect(mock.seen).toHaveLength(2);
    expect(mock.seen[0]!.agent).toBe('WanSurvey/0.1 (ops@example.org)');
    expect(mock.seen[1]!.at - mock.seen[0]!.at).toBeGreaterThanOrEqual(150);
    await expect(g.geocode('boom')).rejects.toThrow(/503/);
    expect(normaliseAddress(' Jr. Cusco,  5 ')).toBe('jr cusco 5');
    await mock.close();
  });
});

describe('geocoding, the case map and duplicates across projects', () => {
  let t: TestApp;
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
    tenant = await createTenant(t.admin);
    projectA = await createProject(t.admin, tenant.id, 'Panel A');
    projectB = await createProject(t.admin, tenant.id, 'Panel B');
    pm = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]));
    supervisor = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'supervisor' }]));
    interviewer = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
    interviewerS = await login(t.app, interviewer);
  });
  afterAll(async () => {
    await t.close();
    await mock.close();
  });

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

    const [c] =
      await t.admin`select id from cases where project_id = ${projectB} and external_id = ${'B' + table[1]![0]}`;
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
      await t.admin`select id from cases where project_id = ${projectA} order by external_id`
    ).map((r) => r.id as string);
    const addresses = ['Av. Arequipa 100, Lima', 'Jr. Cusco 5, Cusco', 'Nowhere 1', 'boom'];
    for (const [i, value] of addresses.entries())
      await t.admin`insert into contacts (id, tenant_id, case_id, type, value)
        values (gen_random_uuid(), ${tenant.id}, ${ids[i]!}, 'address', ${value})`;
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
    const audit =
      await t.admin`select details from audit_log where action = 'cases.geocoded' and target_id = ${projectA}`;
    expect(audit[0]!.details).toEqual({ addresses: 4, service: 'nominatim' });
  });

  it('refuses to geocode when no geocoder is set up', async () => {
    const plain = await bootstrap();
    const s = await login(
      plain.app,
      await createUser(plain.admin, tenant.id, [{ role: 'project_manager' }]),
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
