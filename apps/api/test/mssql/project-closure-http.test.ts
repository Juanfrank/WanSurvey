import { createInterview, type CompiledQuestionnaire } from '@wansurvey/logic';
import { ROLE_PERMISSIONS } from '@wansurvey/schema';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQuestionnaire, get, newCase, ownerQuery, patch, post, put } from './fixtures.js';
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

const definition = {
  id: 'CLOSE',
  title: { es: 'Cierre' },
  defaultLanguage: 'es',
  languages: ['es'],
  sections: [
    {
      id: 'S',
      title: { es: 'S' },
      items: [
        { kind: 'question', id: 'AGE', name: 'AGE', type: 'numeric', text: { es: '¿Edad?' } },
      ],
    },
  ],
};

interface Checkout {
  versions: { id: string; compiled: CompiledQuestionnaire }[];
  cases: {
    caseId: string;
    context: { case: Record<string, unknown> };
    questionnaireVersionId: string;
  }[];
}

/**
 * Closing a project: fieldwork stops for everyone (no interview started or sent, no case handed
 * out, web links closed), field roles stop seeing it, whoever runs it, administrators and client
 * viewers keep it; a device still sends what it started before the close; reopening gives the
 * access back with the roles untouched.
 */
describe.skipIf(!configured)('SQL Server: closing a project', () => {
  let t: MssqlTestApp;
  let q: ReturnType<typeof ownerQuery>;
  let tenant: { id: string; slug: string };
  let project: string;
  let other: string;
  let qid: string;
  let pm: Session;
  let admin: Session;
  let client: Session;
  let sup: Session;
  let ivUser: TestUser;
  let iv: Session;
  /** An interviewer of the whole organisation. */
  let orgIv: Session;
  const device = 'device-closing-0001';

  beforeAll(async () => {
    t = await bootstrap();
    q = ownerQuery(t.owner);
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    other = await createProject(t.owner, tenant.id);
    qid = await createQuestionnaire(t.owner, tenant.id, project, { definition, publish: true });
    const as = async (grants: Parameters<typeof createUser>[2]) =>
      login(t, await createUser(t.owner, tenant.id, grants), tenant.slug);
    pm = await as([{ role: 'project_manager', projectId: project }]);
    admin = await as([{ role: 'admin' }]);
    client = await as([{ role: 'client_viewer', projectId: project }]);
    sup = await as([{ role: 'supervisor', projectId: project }]);
    ivUser = await createUser(t.owner, tenant.id, [
      { role: 'interviewer', projectId: project },
      { role: 'interviewer', projectId: other },
    ]);
    iv = await login(t, ivUser, tenant.slug);
    orgIv = await as([{ role: 'interviewer' }]);
    for (const status of ['active'])
      await patch(pm, `/projects/${project}`, { status }).expect(200);
  });
  afterAll(async () => {
    await t?.close();
  });

  const ids = async (s: Session) => {
    const r = await get(s, '/projects');
    // Someone left with no open project gets an empty list, not a refusal.
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body as { id: string }[]).map((p) => p.id);
  };
  const close = () => patch(pm, `/projects/${project}`, { status: 'closed' }).expect(200);
  const reopen = () => patch(pm, `/projects/${project}`, { status: 'active' }).expect(200);

  /** Answers AGE on a device, as the web client does, and returns the ops and the path. */
  function onDevice(co: Checkout, id: string, startedAt: string) {
    const c = co.cases[0]!;
    const v = co.versions.find((x) => x.id === c.questionnaireVersionId)!;
    const s = createInterview(v.compiled, {
      mode: 'CAPI',
      language: 'es',
      seed: id,
      now: () => new Date(startedAt),
      context: { case: c.context.case },
    });
    s.setAnswer('AGE', 41);
    s.next();
    const ops = s.drainEvents().map((e, i) => ({
      seq: i + 1,
      kind: 'answer' as const,
      variable: e.key,
      oldValue: e.oldValue,
      newValue: e.newValue,
      at: startedAt,
      source: e.source,
      reason: e.reason ?? null,
    }));
    const start = {
      caseId: c.caseId,
      questionnaireVersionId: c.questionnaireVersionId,
      mode: 'CAPI',
      language: 'es',
      startedAt,
    };
    return { ops, state: s.state(), path: s.pathKeys(), start };
  }

  it('warns before closing: who loses access and what is on devices', async () => {
    const c = await newCase(t.owner, tenant.id, project, { holder: ivUser.id });
    await q`UPDATE cases SET checked_out_device = ${device}, checked_out_by = ${ivUser.id} WHERE id = ${c}`;
    const res = await get(pm, `/projects/${project}/closeout`).expect(200);
    // The interviewer, the supervisor and the organisation's interviewer lose it; the project
    // manager, the administrator and the client do not.
    expect(res.body).toMatchObject({ status: 'active', closedAt: null, casesOnDevices: 1 });
    expect(res.body.fieldPeople).toBe(3);
    expect(res.body.grants).toBeUndefined();
    await q`UPDATE cases SET checked_out_device = NULL, checked_out_by = NULL WHERE id = ${c}`;
  });

  it('field roles stop seeing a closed project; the others keep it; reopening gives it back', async () => {
    expect(await ids(iv)).toEqual(expect.arrayContaining([project, other]));
    expect(await ids(orgIv)).toContain(project);
    await close();
    const [row] = await q`SELECT status, closed_at FROM projects WHERE id = ${project}`;
    expect(row!.status).toBe('closed');
    expect(row!.closed_at).toBeTruthy();

    for (const s of [iv, orgIv, sup]) {
      expect(await ids(s)).not.toContain(project);
      const r = await get(s, `/projects/${project}`);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('PROJECT_CLOSED');
    }
    expect(await ids(sup)).toEqual([]);
    expect((await get(sup, '/home')).status).toBe(200);
    // Their other projects are untouched.
    expect(await ids(iv)).toContain(other);
    expect((await get(iv, `/projects/${other}`)).status).toBe(200);
    // Who runs it, the administrator and the client keep it.
    for (const s of [pm, admin, client]) {
      expect(await ids(s)).toContain(project);
      expect((await get(s, `/projects/${project}`)).status).toBe(200);
    }
    // The roles themselves are not touched.
    const grants = await q`SELECT role FROM memberships WHERE user_id = ${ivUser.id}`;
    expect(grants).toHaveLength(2);
    // The session says which closed projects an organisation-wide field role no longer reaches.
    const me = await get(orgIv, '/auth/me');
    expect(me.body.memberships[0].exceptProjects).toEqual([project]);

    await reopen();
    const [open] = await q`SELECT closed_at FROM projects WHERE id = ${project}`;
    expect(open!.closed_at).toBeNull();
    for (const s of [iv, orgIv, sup]) {
      expect(await ids(s)).toContain(project);
      expect((await get(s, `/projects/${project}`)).status).toBe(200);
    }
  });

  it('stops fieldwork for everyone: no start, no download, no assignment, no claim', async () => {
    const c = await newCase(t.owner, tenant.id, project, { holder: ivUser.id });
    const free = await newCase(t.owner, tenant.id, project);
    await close();
    try {
      // The administrator holds every permission, and still cannot start an interview here.
      const start = await post(admin, `/projects/${project}/interviews`, {
        id: randomUUID(),
        caseId: c,
        questionnaireId: qid,
        mode: 'CAPI',
        deviceId: device,
      });
      expect(start.status).toBe(409);
      expect(start.body.code).toBe('PROJECT_CLOSED');
      // The interviewer no longer reaches the project at all.
      const own = await post(iv, `/projects/${project}/interviews`, {
        id: randomUUID(),
        caseId: c,
        questionnaireId: qid,
        mode: 'CAPI',
        deviceId: device,
      });
      expect(own.status).toBe(403);
      expect(own.body.code).toBe('PROJECT_CLOSED');
      const co = await post(admin, `/projects/${project}/capi/checkout`, {
        deviceId: device,
        caseIds: [c],
      });
      expect(co.body.code).toBe('PROJECT_CLOSED');
      const next = await post(admin, `/projects/${project}/cati/next`, { deviceId: device });
      expect(next.body.code).toBe('PROJECT_CLOSED');
      // Cases are neither assigned nor taken.
      const assign = await post(pm, `/projects/${project}/cases/assign`, {
        caseIds: [free],
        userId: ivUser.id,
      });
      expect(assign.status).toBe(409);
      expect(assign.body.code).toBe('PROJECT_CLOSED');
      const claim = await post(admin, `/projects/${project}/cases/${free}/claim`);
      expect(claim.body.code).toBe('PROJECT_CLOSED');
      const [still] = await q`SELECT assigned_to FROM cases WHERE id = ${free}`;
      expect(still!.assigned_to).toBeNull();
    } finally {
      await reopen();
    }
    // Open again: the same work goes through.
    const ok = await post(pm, `/projects/${project}/cases/assign`, {
      caseIds: [free],
      userId: ivUser.id,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('web links stop opening the survey with a closed page, and open again on reopening', async () => {
    const link = await put(pm, `/projects/${project}/open-link`, {
      active: true,
      questionnaireId: qid,
    });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const slug = link.body.link.slug as string;
    const api = () => request(t.app.getHttpServer());
    const started = await api().post(`/api/v1/public/o/${slug}/start`);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const token = started.body.token as string;
    await close();
    try {
      const fresh = await api().post(`/api/v1/public/o/${slug}/start`);
      expect(fresh.status).toBe(410);
      expect(fresh.body.code).toBe('PROJECT_CLOSED');
      const opened = await api().get(`/api/v1/public/s/${token}?device=browser-closed-1`);
      expect(opened.status).toBe(410);
      expect(opened.body.code).toBe('PROJECT_CLOSED');
    } finally {
      await reopen();
    }
    expect((await api().get(`/api/v1/public/s/${token}?device=browser-closed-1`)).status).toBe(200);
    await put(pm, `/projects/${project}/open-link`, { active: false });
  });

  it('takes from a device what was started before the close, and nothing started after', async () => {
    const before = await newCase(t.owner, tenant.id, project, { holder: ivUser.id });
    const after = await newCase(t.owner, tenant.id, project, { holder: ivUser.id });
    const co1 = (
      await post(iv, `/projects/${project}/capi/checkout`, { deviceId: device, caseIds: [before] })
    ).body as Checkout;
    const co2 = (
      await post(iv, `/projects/${project}/capi/checkout`, { deviceId: device, caseIds: [after] })
    ).body as Checkout;
    const early = randomUUID();
    const late = randomUUID();
    const a = onDevice(co1, early, new Date(Date.now() - 3_600_000).toISOString());
    await close();
    try {
      const b = onDevice(co2, late, new Date(Date.now() + 1000).toISOString());
      // One sync: the interview started before the close is created; the later one is refused.
      const sync = await post(iv, '/interviews/sync', {
        deviceId: device,
        projectId: project,
        projectIds: [other],
        interviews: [
          { id: early, start: a.start, ops: a.ops, state: a.state },
          { id: late, start: b.start, ops: b.ops, state: b.state },
        ],
      });
      expect(sync.status, JSON.stringify(sync.body)).toBe(200);
      expect(sync.body.acks[early]).toBe(a.ops.length);
      expect(sync.body.errors[late]).toBe('PROJECT_CLOSED');
      // The device learns the project is closed (and that the other one is not).
      expect(sync.body.closedProjects).toEqual([project]);
      // It is sent from the device it was made on; moving it to another device is refused.
      const moved = await post(iv, `/interviews/${early}/takeover`, {
        deviceId: 'device-closing-0002',
      });
      expect(moved.status).toBe(409);
      expect(moved.body.code).toBe('PROJECT_CLOSED');
      const sub = await post(iv, `/interviews/${early}/submit`, {
        deviceId: device,
        seq: a.ops.length,
        path: a.path,
      });
      expect(sub.status, JSON.stringify(sub.body)).toBe(200);
      const [c] = await q`SELECT status FROM cases WHERE id = ${before}`;
      expect(c!.status).toBe('finalised');
      // A device's start time before the close does not count before the case reached it.
      await q`UPDATE cases SET checked_out_at = SYSDATETIMEOFFSET() WHERE id = ${after}`;
      const backdated = randomUUID();
      const d = onDevice(co2, backdated, new Date(Date.now() - 7_200_000).toISOString());
      const forged = await post(iv, '/interviews/sync', {
        deviceId: device,
        interviews: [{ id: backdated, start: d.start, ops: d.ops, state: d.state }],
      });
      expect(forged.body.errors[backdated]).toBe('PROJECT_CLOSED');
      // Giving the cases back still works after the close.
      const back = await post(iv, `/projects/${project}/capi/checkin`, {
        deviceId: device,
        caseIds: [before, after],
      });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      expect(back.body.checkedIn).toEqual(expect.arrayContaining([after]));
      const [none] = await q`SELECT COUNT(*) AS n FROM interviews WHERE id = ${late}`;
      expect(Number(none!.n)).toBe(0);
    } finally {
      await reopen();
    }
  });

  it('reopening an expired case is for whoever runs the project, while fieldwork goes on', async () => {
    // This organisation lets supervisors edit cases: still not reopen them.
    const supervisor = [...ROLE_PERMISSIONS.supervisor, 'cases.edit'];
    await q`UPDATE tenants SET role_permissions = ${JSON.stringify({ supervisor })} WHERE id = ${tenant.id}`;
    try {
      const c = await newCase(t.owner, tenant.id, project, { status: 'finalised' });
      await q`UPDATE cases SET disposition = 'EXPIRED' WHERE id = ${c}`;
      const url = `/projects/${project}/cases/${c}`;
      expect((await get(sup, url)).body.canReopen).toBe(false);
      expect((await get(pm, url)).body.canReopen).toBe(true);
      const refused = await patch(sup, url, { status: 'fresh' });
      expect(refused.status).toBe(403);
      await close();
      try {
        expect((await get(pm, url)).body.canReopen).toBe(false);
        expect((await patch(pm, url, { status: 'fresh' })).body.code).toBe('PROJECT_CLOSED');
      } finally {
        await reopen();
      }
      await patch(pm, url, { status: 'fresh' }).expect(200);
      const [row] = await q`SELECT status FROM cases WHERE id = ${c}`;
      expect(row!.status).toBe('fresh');
    } finally {
      await q`UPDATE tenants SET role_permissions = '{}' WHERE id = ${tenant.id}`;
    }
  });

  it('reopening a project is for whoever runs it', async () => {
    await close();
    try {
      expect((await patch(sup, `/projects/${project}`, { status: 'active' })).status).toBe(403);
      expect((await patch(client, `/projects/${project}`, { status: 'active' })).status).toBe(403);
    } finally {
      await reopen();
    }
  });
});
