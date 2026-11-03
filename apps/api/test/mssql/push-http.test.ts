import { createDecipheriv, createECDH, hkdfSync, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service.js';
import type { AuthContext } from '../../src/common/auth-context.js';
import { resetConfigCache } from '../../src/config.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { PushService } from '../../src/push/push.service.js';
import { generateVapidKeys } from '../../src/push/webpush.js';
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
  type TestUser,
} from './harness.js';

interface Hit {
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

/** A browser's side: its keys, and what it does with a push (RFC 8291, read back). */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from(randomUUID().replace(/-/g, '').slice(0, 16));
  return {
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    read(body: Buffer) {
      const salt = body.subarray(0, 16);
      const idlen = body[20]!;
      const asPublic = body.subarray(21, 21 + idlen);
      const data = body.subarray(21 + idlen);
      const secret = ecdh.computeSecret(asPublic);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
      const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
      const cek = Buffer.from(
        hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
      );
      const nonce = Buffer.from(
        hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
      );
      const d = createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(data.subarray(-16));
      const plain = Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
      return JSON.parse(plain.subarray(0, -1).toString()) as {
        title: string;
        body: string;
        url: string;
        tag: string;
      };
    },
  };
}

/** Web notifications: subscriptions, the events that become notifications, delivery (ADR 0001, 6). */
describe.skipIf(!configured)('SQL Server: web notifications', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let me: Session;
  let meUser: TestUser;
  let boss: Session;
  let bossUser: TestUser;
  let service: Server;
  let base: string;
  let answer = 201;
  const hits: Hit[] = [];
  let seq = 0;
  const vapid = generateVapidKeys();

  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;
  const ctxOf = (u: TestUser): AuthContext =>
    ({
      tenantId: tenant.id,
      userId: u.id,
      ip: null,
      userAgent: null,
      memberships: [],
    }) as unknown as AuthContext;
  const put = (s: Session, body: object) =>
    s.agent.put('/api/v1/push/subscription').set('x-csrf-token', s.csrf).send(body);
  async function subscribe(s: Session, categories: string[], lang = 'es') {
    const b = browser();
    const endpoint = `${base}/push/${++seq}`;
    const res = await put(s, { endpoint, keys: b.keys, categories, lang });
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    return { b, endpoint, path: `/push/${seq}` };
  }
  const hitsOf = (path: string) => hits.filter((h) => h.path === path);
  const deliver = async () => {
    await t.app.get(JobsService).drain();
    return t.app.get(PushService).deliverDue();
  };
  const outbox = (userId: string, category?: string) =>
    rows(
      sql`SELECT * FROM push_outbox WHERE user_id = ${userId} ${category ? sql`AND category = ${category}` : sql``} ORDER BY created_at`,
    );

  beforeAll(async () => {
    service = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        hits.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
        res.statusCode = answer;
        res.end();
      });
    });
    await new Promise<void>((ok) => service.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    process.env.VAPID_SUBJECT = 'mailto:admin@example.org';
    resetConfigCache();
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    qid = await createQuestionnaire(t.owner, tenant.id, project, {
      definition: {
        id: 'PUSH',
        title: { es: 'P' },
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
    meUser = await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]);
    me = await login(t, meUser, tenant.slug);
    bossUser = await createUser(t.owner, tenant.id, [{ role: 'supervisor', projectId: project }]);
    boss = await login(t, bossUser, tenant.slug);
  });
  afterAll(async () => {
    for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'])
      delete process.env[k];
    resetConfigCache();
    await new Promise((ok) => service?.close(ok));
    await t?.close();
  });

  it('gives the browser the public key, and keeps one subscription per browser', async () => {
    const cfg = await me.agent.get('/api/v1/push/config');
    expect(cfg.body).toEqual({ enabled: true, publicKey: vapid.publicKey });
    const s = await subscribe(me, ['returned']);
    const state = await me.agent.get('/api/v1/push/subscription').query({ endpoint: s.endpoint });
    expect(state.body).toEqual({ subscribed: true, categories: ['returned'] });
    // The same browser again with other choices: one row, new choices.
    await put(me, {
      endpoint: s.endpoint,
      keys: s.b.keys,
      categories: ['returned', 'exports'],
      lang: 'es',
    });
    const again = await me.agent.get('/api/v1/push/subscription').query({ endpoint: s.endpoint });
    expect(again.body.categories).toEqual(['returned', 'exports']);
    expect(
      await rows(sql`SELECT 1 AS x FROM push_subscriptions WHERE user_id = ${meUser.id}`),
    ).toHaveLength(1);
    // Another person's state of that browser is "not subscribed".
    expect(
      (await boss.agent.get('/api/v1/push/subscription').query({ endpoint: s.endpoint })).body
        .subscribed,
    ).toBe(false);
    await me.agent
      .delete('/api/v1/push/subscription')
      .set('x-csrf-token', me.csrf)
      .send({ endpoint: s.endpoint })
      .expect(204);
    expect(
      (await me.agent.get('/api/v1/push/subscription').query({ endpoint: s.endpoint })).body
        .subscribed,
    ).toBe(false);
  });

  it('refuses addresses that are not push services and malformed keys', async () => {
    const b = browser();
    expect(
      (await put(me, { endpoint: 'ftp://x.org/a', keys: b.keys, categories: [] })).status,
    ).toBe(400);
    expect(
      (
        await put(me, {
          endpoint: `${base}/x`,
          keys: { p256dh: 'short', auth: 'short' },
          categories: [],
        })
      ).status,
    ).toBe(400);
    expect(
      (await put(me, { endpoint: `${base}/x`, keys: b.keys, categories: ['nope'] })).status,
    ).toBe(400);
  });

  it('sends a returned interview to its interviewer, encrypted, signed, and with no personal data', async () => {
    const s = await subscribe(me, ['returned'], 'es');
    const other = await subscribe(boss, ['returned']);
    const iv = randomUUID();
    const v = (
      (await rows(sql`SELECT id FROM questionnaire_versions WHERE questionnaire_id = ${qid}`))[0]!
        .id as string
    ).toLowerCase();
    const caseId = await newCase(t.owner, tenant.id, project, {
      holder: meUser.id,
      sample: { first_name: 'Rosa Quispe' },
    });
    await sql`INSERT INTO interviews (id, tenant_id, project_id, case_id, questionnaire_version_id, mode, interviewer_id, status, language, device_id, answers, state, context)
              VALUES (${iv}, ${tenant.id}, ${project}, ${caseId}, ${v}, 'CAPI', ${meUser.id}, 'returned', 'es', 'd', '{}', '{}', '{}')`.execute(
      t.owner,
    );
    answer = 201;
    await t.app.get(AuditService).record(ctxOf(bossUser), {
      action: 'interview.returned',
      targetType: 'interview',
      targetId: iv,
    });
    expect(await outbox(meUser.id, 'returned')).toHaveLength(1);
    expect(await deliver()).toBeGreaterThanOrEqual(1);

    const hit = hitsOf(s.path).at(-1)!;
    expect(hit.headers['content-encoding']).toBe('aes128gcm');
    expect(hit.headers.ttl).toBe('3600');
    expect(String(hit.headers.authorization)).toMatch(
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`),
    );
    const message = s.b.read(hit.body);
    expect(message).toMatchObject({ title: 'Entrevista devuelta', tag: 'returned' });
    expect(JSON.stringify(message)).not.toContain('Rosa');
    // The supervisor who returned it hears nothing.
    expect(hitsOf(other.path)).toHaveLength(0);
    expect((await outbox(meUser.id, 'returned'))[0]).toMatchObject({ status: 'delivered' });
  });

  it('tells the person in English when that is the browser’s language, and honours the chosen categories', async () => {
    const en = await subscribe(me, ['assignments'], 'en');
    await t.app.get(AuditService).record(ctxOf(bossUser), {
      action: 'cases.assigned',
      targetType: 'project',
      targetId: project,
      details: { to: meUser.id, count: 3 },
    });
    await deliver();
    expect(en.b.read(hitsOf(en.path).at(-1)!.body)).toMatchObject({
      title: 'New cases',
      body: '3 cases were assigned to you.',
    });
    // A distribution names several people.
    await t.app.get(AuditService).record(ctxOf(bossUser), {
      action: 'cases.assigned',
      targetType: 'project',
      targetId: project,
      details: { distributed: true, perPerson: { [meUser.id]: 1, [bossUser.id]: 5 } },
    });
    expect(await outbox(meUser.id, 'assignments')).toHaveLength(2);
    // Nobody subscribed to a category: nothing is queued for it.
    expect(await outbox(bossUser.id, 'assignments')).toHaveLength(0);
  });

  it('forgets a browser that is gone (410), and tries a push service that fails again later', async () => {
    const s = await subscribe(me, ['exports']);
    await t.app.get(AuditService).record(ctxOf(bossUser), {
      action: 'cases.assigned',
      targetType: 'project',
      targetId: project,
      details: { to: meUser.id, count: 1 },
    });
    // Only the exports category: this browser is not sent that one. Use the test notification instead.
    answer = 503;
    await me.agent.post('/api/v1/push/test').set('x-csrf-token', me.csrf).expect(204);
    await deliver();
    const [first] = await rows(
      sql`SELECT TOP 1 * FROM push_outbox WHERE user_id = ${meUser.id} AND category = 'test' ORDER BY created_at DESC`,
    );
    expect(first).toMatchObject({ status: 'pending', attempt: 1, last_error: 'HTTP 503' });
    await sql`UPDATE push_outbox SET next_attempt_at = DATEADD(minute, -1, SYSDATETIMEOFFSET()), claimed_until = NULL WHERE user_id = ${meUser.id} AND status = 'pending'`.execute(
      t.owner,
    );
    answer = 410;
    await deliver();
    expect(
      await rows(
        sql`SELECT 1 AS x FROM push_subscriptions WHERE endpoint_hash IS NOT NULL AND endpoint = ${s.endpoint}`,
      ),
    ).toHaveLength(0);
  });

  it('announces the callbacks about to be due, once per person and window', async () => {
    answer = 201;
    const s = await subscribe(me, ['callbacks']);
    for (let i = 0; i < 2; i++) {
      const id = await newCase(t.owner, tenant.id, project, {
        holder: meUser.id,
        status: 'assigned',
      });
      await sql`UPDATE cases SET callback_user_id = ${meUser.id}, next_contact_at = DATEADD(minute, 2, SYSDATETIMEOFFSET()) WHERE id = ${id}`.execute(
        t.owner,
      );
    }
    // A callback far away is not announced.
    const far = await newCase(t.owner, tenant.id, project, {
      holder: meUser.id,
      status: 'assigned',
    });
    await sql`UPDATE cases SET callback_user_id = ${meUser.id}, next_contact_at = DATEADD(hour, 3, SYSDATETIMEOFFSET()) WHERE id = ${far}`.execute(
      t.owner,
    );
    const svc = t.app.get(PushService);
    const now = new Date();
    expect(await svc.callbacksDue(now)).toBeGreaterThanOrEqual(1);
    expect(await svc.callbacksDue(now)).toBe(0);
    await deliver();
    const msg = s.b.read(hitsOf(s.path).at(-1)!.body);
    expect(msg).toMatchObject({
      title: 'Llamadas pendientes',
      body: 'Tiene 2 llamadas por hacer pronto.',
    });
  });

  it('does not send to someone who is no longer an active member', async () => {
    const gone = await createUser(t.owner, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    const sess = await login(t, gone, tenant.slug);
    const s = await subscribe(sess, ['assignments']);
    await t.app.get(AuditService).record(ctxOf(bossUser), {
      action: 'cases.assigned',
      targetType: 'project',
      targetId: project,
      details: { to: gone.id, count: 1 },
    });
    await sql`UPDATE tenant_members SET status = 'deactivated' WHERE user_id = ${gone.id}`.execute(
      t.owner,
    );
    answer = 201;
    await deliver();
    expect(hitsOf(s.path)).toHaveLength(0);
  });

  it('never shows another organisation’s subscriptions', async () => {
    const other = await createTenant(t.owner);
    const o2 = await login(t, await createUser(t.owner, other.id, [{ role: 'owner' }]), other.slug);
    const b = browser();
    const endpoint = `${base}/push/shared`;
    await put(me, { endpoint, keys: b.keys, categories: ['returned'] }).expect(204);
    expect(
      (await o2.agent.get('/api/v1/push/subscription').query({ endpoint })).body.subscribed,
    ).toBe(false);
  });
});
