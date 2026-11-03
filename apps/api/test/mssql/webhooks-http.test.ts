import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import type { AuthContext } from '../../src/common/auth-context.js';
import {
  DISABLE_AFTER,
  RETRY_MINUTES,
  WebhooksService,
} from '../../src/webhooks/webhooks.service.js';
import { verify } from '../../src/webhooks/signing.js';
import { createQuestionnaire, newCase } from './fixtures.js';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
} from './harness.js';

interface Hit {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** Outgoing webhooks: the outbox, signed deliveries, retries, isolation (ADR 0001, phase B). */
describe.skipIf(!configured)('SQL Server: outgoing webhooks', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let projectA: string;
  let projectB: string;
  let owner: Session;
  let admin: Session;
  let ownerUserId: string;
  let receiver: Server;
  let url: string;
  const hits: Hit[] = [];
  let answer = 200;

  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;
  const ctx = (): AuthContext =>
    ({
      tenantId: tenant.id,
      userId: ownerUserId,
      ip: null,
      userAgent: null,
      memberships: [],
    }) as unknown as AuthContext;
  let tag = 0;
  /** Each endpoint has a path of its own, so what it received can be told apart. */
  const paths = new Map<string, string>();
  const create = async (body: Record<string, unknown> = {}, s: Session = owner) => {
    const path = `/hook-${++tag}`;
    const res = await s.agent
      .post('/api/v1/webhooks')
      .set('x-csrf-token', s.csrf)
      .send({
        url: `${url}${path}`,
        events: ['case.status_changed', 'interview.status_changed'],
        ...body,
      });
    if (res.body?.id) paths.set(res.body.id, path);
    return res;
  };
  const hitsOf = (id: string) => hits.filter((h) => h.path === paths.get(id));
  /** Inline jobs may be running one delivery already: wait for them, then run the rest. */
  const deliver = async () => {
    await t.app.get(JobsService).drain();
    await t.app.get(WebhooksService).deliverDue();
  };
  const emitCase = async (caseId: string) =>
    t.app
      .get(AuditService)
      .record(ctx(), { action: 'case.updated', targetType: 'case', targetId: caseId });
  const due = () =>
    sql`UPDATE webhook_deliveries SET next_attempt_at = DATEADD(minute, -1, SYSDATETIMEOFFSET()), claimed_until = NULL WHERE status = 'pending' AND tenant_id = ${tenant.id}`.execute(
      t.owner,
    );
  const deliveriesOf = (id: string) =>
    rows(sql`SELECT * FROM webhook_deliveries WHERE endpoint_id = ${id} ORDER BY created_at`);

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push({ path: req.url ?? '', headers: req.headers, body });
        res.statusCode = answer;
        res.end('ok');
      });
    });
    await new Promise<void>((ok) => receiver.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

    t = await bootstrap();
    tenant = await createTenant(t.owner);
    projectA = await createProject(t.owner, tenant.id);
    projectB = await createProject(t.owner, tenant.id);
    const o = await createUser(t.owner, tenant.id, [{ role: 'owner' }]);
    ownerUserId = o.id;
    owner = await login(t, o, tenant.slug);
    admin = await login(t, await createUser(t.owner, tenant.id, [{ role: 'admin' }]), tenant.slug);
  });
  afterAll(async () => {
    await new Promise((ok) => receiver?.close(ok));
    await t?.close();
  });

  it('is managed by owners only, and shows the secret once', async () => {
    expect((await create({}, admin)).status).toBe(403);
    const res = await create();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_/);
    const list = await owner.agent.get('/api/v1/webhooks');
    expect(JSON.stringify(list.body)).not.toContain(res.body.secret);
    const [stored] = await rows(
      sql`SELECT secret_enc FROM webhook_endpoints WHERE id = ${res.body.id}`,
    );
    expect(stored!.secret_enc).toMatch(/^v1\./);
    expect(stored!.secret_enc).not.toContain(res.body.secret.slice(6));
  });

  it('refuses unknown events and addresses that are not addresses', async () => {
    expect((await create({ events: ['nope'] })).status).toBe(400);
    expect((await create({ events: [] })).status).toBe(400);
    expect((await create({ url: 'ftp://example.org/x' })).status).toBe(400);
    expect((await create({ url: 'https://nonexistent.invalid/x' })).status).toBe(400);
  });

  it('delivers a signed event with identifiers only, once, in the transaction of the change', async () => {
    const { body: ep } = (await create({ events: ['case.status_changed'] })) as {
      body: { id: string; secret: string };
    };
    const caseId = await newCase(t.owner, tenant.id, projectA, {
      sample: { name: 'Rosa Quispe' },
      status: 'assigned',
    });
    hits.length = 0;
    await emitCase(caseId);
    const [pending] = await deliveriesOf(ep.id);
    expect(pending).toMatchObject({ status: 'pending', event: 'case.status_changed' });

    await deliver();
    expect(hitsOf(ep.id)).toHaveLength(1);
    const hit = hitsOf(ep.id)[0]!;
    expect(verify(ep.secret, hit.headers as Record<string, string>, hit.body)).toBe(true);
    const event = JSON.parse(hit.body);
    expect(event.type).toBe('case.status_changed');
    expect(event.data).toEqual({ caseId, status: 'assigned', projectId: projectA });
    expect(hit.body).not.toContain('Quispe');
    const [done] = await deliveriesOf(ep.id);
    expect(done).toMatchObject({ status: 'delivered', attempt: 1, last_status_code: 200 });

    // Nothing is sent twice.
    await deliver();
    expect(hitsOf(ep.id)).toHaveLength(1);
  });

  it('retries a failing delivery on the schedule, and gives up after the last wait', async () => {
    const { body: ep } = (await create({ events: ['case.status_changed'] })) as {
      body: { id: string };
    };
    const caseId = await newCase(t.owner, tenant.id, projectA, { status: 'assigned' });
    answer = 500;
    hits.length = 0;
    await emitCase(caseId);
    await deliver();
    let [d] = (await deliveriesOf(ep.id)).slice(-1);
    expect(d).toMatchObject({
      status: 'pending',
      attempt: 1,
      last_status_code: 500,
      last_error: 'HTTP 500',
    });
    expect(new Date(d!.next_attempt_at as string).getTime() - Date.now()).toBeGreaterThan(30_000);
    // Not yet due: not tried.
    const before = hitsOf(ep.id).length;
    await deliver();
    expect(hitsOf(ep.id)).toHaveLength(before);

    for (let i = 1; i <= RETRY_MINUTES.length; i++) {
      await due();
      await deliver();
    }
    [d] = (await deliveriesOf(ep.id)).slice(-1);
    expect(d).toMatchObject({ status: 'failed', attempt: RETRY_MINUTES.length + 1 });

    // Redelivery by hand, now that the receiver is well again.
    answer = 200;
    expect(
      (
        await owner.agent
          .post(`/api/v1/webhooks/deliveries/${d!.id}/redeliver`)
          .set('x-csrf-token', owner.csrf)
      ).status,
    ).toBe(204);
    await due();
    await deliver();
    [d] = (await deliveriesOf(ep.id)).slice(-1);
    expect(d).toMatchObject({ status: 'delivered', attempt: 1 });
  });

  it('switches an endpoint off after a run of deliveries that gave up, and on again by hand', async () => {
    const { body: ep } = (await create({ events: ['case.status_changed'] })) as {
      body: { id: string };
    };
    await sql`UPDATE webhook_endpoints SET failure_streak = ${DISABLE_AFTER - 1} WHERE id = ${ep.id}`.execute(
      t.owner,
    );
    const caseId = await newCase(t.owner, tenant.id, projectA, { status: 'assigned' });
    answer = 500;
    await emitCase(caseId);
    await sql`UPDATE webhook_deliveries SET attempt = ${RETRY_MINUTES.length} WHERE endpoint_id = ${ep.id}`.execute(
      t.owner,
    );
    await deliver();
    const [e] = await rows(
      sql`SELECT enabled, disabled_reason FROM webhook_endpoints WHERE id = ${ep.id}`,
    );
    expect(e!.enabled).toBe(false);
    expect(e!.disabled_reason).toContain('failed in a row');
    // A disabled endpoint receives no new events.
    await emitCase(caseId);
    expect(await deliveriesOf(ep.id)).toHaveLength(1);
    answer = 200;
    expect(
      (
        await owner.agent
          .patch(`/api/v1/webhooks/${ep.id}`)
          .set('x-csrf-token', owner.csrf)
          .send({ enabled: true })
      ).status,
    ).toBe(204);
    await emitCase(caseId);
    expect(await deliveriesOf(ep.id)).toHaveLength(2);
  });

  it('keeps a project endpoint to its project', async () => {
    const { body: ep } = (await create({
      projectId: projectB,
      events: ['case.status_changed'],
    })) as {
      body: { id: string };
    };
    await emitCase(await newCase(t.owner, tenant.id, projectA, { status: 'assigned' }));
    expect(await deliveriesOf(ep.id)).toHaveLength(0);
    await emitCase(await newCase(t.owner, tenant.id, projectB, { status: 'assigned' }));
    expect(await deliveriesOf(ep.id)).toHaveLength(1);
  });

  it('sends interview status changes', async () => {
    const { body: ep } = (await create({ events: ['interview.status_changed'] })) as {
      body: { id: string };
    };
    const iv = randomUUID();
    const q = await createQuestionnaire(t.owner, tenant.id, projectA, {
      definition: {
        id: 'WH',
        title: { es: 'WH' },
        defaultLanguage: 'es',
        languages: ['es'],
        sections: [
          {
            id: 'S',
            title: { es: 'S' },
            items: [{ kind: 'question', id: 'A', name: 'A', type: 'numeric', text: { es: 'A' } }],
          },
        ],
      },
      publish: true,
    });
    const v = (
      (await rows(sql`SELECT id FROM questionnaire_versions WHERE questionnaire_id = ${q}`))[0]!
        .id as string
    ).toLowerCase();
    await sql`INSERT INTO interviews (id, tenant_id, project_id, questionnaire_version_id, mode, status, language, device_id, answers, state, context)
              VALUES (${iv}, ${tenant.id}, ${projectA}, ${v}, 'CATI', 'approved', 'es', 'd', '{}', '{}', '{}')`.execute(
      t.owner,
    );
    await t.app
      .get(AuditService)
      .record(ctx(), { action: 'interview.approved', targetType: 'interview', targetId: iv });
    const [d] = await deliveriesOf(ep.id);
    expect(JSON.parse(d!.payload as string).data).toEqual({
      interviewId: iv,
      caseId: null,
      status: 'approved',
      projectId: projectA,
    });
  });

  it('signs with the old secret too for a day after a rotation', async () => {
    const { body: ep } = (await create({ events: ['case.status_changed'] })) as {
      body: { id: string; secret: string };
    };
    const rotated = await owner.agent
      .post(`/api/v1/webhooks/${ep.id}/rotate-secret`)
      .set('x-csrf-token', owner.csrf);
    expect(rotated.status).toBe(201);
    hits.length = 0;
    answer = 200;
    await emitCase(await newCase(t.owner, tenant.id, projectA, { status: 'assigned' }));
    await deliver();
    const hit = hitsOf(ep.id).at(-1)!;
    expect(String(hit.headers['webhook-signature']).split(' ')).toHaveLength(2);
    const h = hit.headers as Record<string, string>;
    expect(verify(ep.secret, h, hit.body)).toBe(true);
    expect(verify(rotated.body.secret, h, hit.body)).toBe(true);
  });

  it('sends a ping on request', async () => {
    const { body: ep } = (await create()) as { body: { id: string; secret: string } };
    hits.length = 0;
    expect(
      (await owner.agent.post(`/api/v1/webhooks/${ep.id}/test`).set('x-csrf-token', owner.csrf))
        .status,
    ).toBe(204);
    await deliver();
    expect(JSON.parse(hitsOf(ep.id).at(-1)!.body).type).toBe('ping');
    const log = await owner.agent.get(`/api/v1/webhooks/${ep.id}/deliveries`);
    expect(log.body[0]).toMatchObject({ event: 'ping', status: 'delivered', statusCode: 200 });
  });

  it('never reaches another organisation', async () => {
    const { body: ep } = (await create()) as { body: { id: string } };
    const other = await createTenant(t.owner);
    const o2 = await login(t, await createUser(t.owner, other.id, [{ role: 'owner' }]), other.slug);
    expect((await o2.agent.get('/api/v1/webhooks')).body).toEqual([]);
    expect(
      (await o2.agent.delete(`/api/v1/webhooks/${ep.id}`).set('x-csrf-token', o2.csrf)).status,
    ).toBe(404);
    expect(
      (await o2.agent.post(`/api/v1/webhooks/${ep.id}/test`).set('x-csrf-token', o2.csrf)).status,
    ).toBe(404);
  });
});
