import { createInterview, type CompiledQuestionnaire } from '@wansurvey/logic';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WaveDispatcher } from '../src/cawi/dispatcher.js';
import { resetConfigCache } from '../src/config.js';
import {
  bootstrap,
  createProject,
  createQuestionnaire,
  createTenant,
  createUser,
  login,
  type Session,
  type TestApp,
} from './harness.js';

const definition = {
  id: 'WEB',
  title: { es: 'Web' },
  defaultLanguage: 'es',
  languages: ['es'],
  sections: [
    {
      id: 'S',
      title: { es: 'S' },
      items: [
        { kind: 'question', id: 'AGE', name: 'AGE', type: 'numeric', text: { es: '¿Edad?' } },
        {
          kind: 'question',
          id: 'NAME',
          name: 'NAME',
          type: 'text',
          text: { es: '¿Su nombre, {{case.first_name}}?' },
        },
      ],
    },
  ],
};
const SECRET = 'webhook-secret-1234567890';

describe('web surveys by e-mail', () => {
  let t: TestApp;
  let tenant: { id: string };
  let project: string;
  let qid: string;
  let pm: Session;
  let dispatcher: WaveDispatcher;

  beforeAll(async () => {
    process.env.MAIL_WEBHOOK_SECRET = SECRET;
    process.env.PUBLIC_WEB_URL = 'http://survey.test';
    resetConfigCache();
    t = await bootstrap();
    dispatcher = t.app.get(WaveDispatcher);
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    qid = await createQuestionnaire(t.admin, tenant.id, project, { definition, publish: true });
    pm = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'project_manager', projectId: project }]),
    );
  });
  afterAll(async () => {
    delete process.env.MAIL_WEBHOOK_SECRET;
    delete process.env.PUBLIC_WEB_URL;
    resetConfigCache();
    await t.close();
  });

  const api = () => request(t.app.getHttpServer());
  const post = (path: string, body: object = {}) =>
    pm.agent.post(`/api/v1${path}`).set('x-csrf-token', pm.csrf).send(body);
  const put = (path: string, body: object) =>
    pm.agent.put(`/api/v1${path}`).set('x-csrf-token', pm.csrf).send(body);
  /** Adds cases with an e-mail each, in bulk. */
  async function addCases(
    n: number,
    prefix: string,
    extra: { consent?: Record<string, boolean> } = {},
  ) {
    const ids: string[] = [];
    const rows = [];
    const cs = [];
    for (let i = 0; i < n; i++) {
      const id = uuidv7();
      ids.push(id);
      rows.push({
        id,
        tenant_id: tenant.id,
        project_id: project,
        external_id: `${prefix}${String(i).padStart(4, '0')}`,
        sample: { first_name: `Ana${i}`, region: i % 3 },
        status: 'fresh',
      });
      cs.push({
        id: uuidv7(),
        tenant_id: tenant.id,
        case_id: id,
        type: 'email',
        value: `${prefix.toLowerCase()}${i}@example.org`,
        consent: t.admin.json(extra.consent ?? {}),
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      await t.admin`insert into cases ${t.admin(rows.slice(i, i + 500))}`;
      await t.admin`insert into contacts ${t.admin(cs.slice(i, i + 500))}`;
    }
    return ids;
  }
  async function drain() {
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const n = await dispatcher.tick();
      total += n;
      if (!n) break;
    }
    return total;
  }
  const tokenOf = (text: string) => text.match(/\/t\/c\/([A-Za-z0-9_-]+)/)![1]!;
  const mailsTo = (to: string) => t.mailer.sent.filter((m) => m.to === to);

  it('words e-mails with checked placeholders, Spanish by default', async () => {
    const list = await pm.agent.get(`/api/v1/projects/${project}/email-templates`);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'invitation', language: 'es', custom: false }),
      ]),
    );
    const bad = await put(`/projects/${project}/email-templates`, {
      kind: 'invitation',
      language: 'es',
      subject: 'Hola',
      body: 'Hola {{foo}} {{link}}',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.problems).toEqual(['foo', 'missing:unsubscribe']);
    const ok = await put(`/projects/${project}/email-templates`, {
      kind: 'invitation',
      language: 'es',
      subject: 'Encuesta para {{case.first_name}}',
      body: 'Hola {{case.first_name}}: {{link}}\nBaja: {{unsubscribe}}',
    });
    expect(ok.status).toBe(200);
  });

  it('sends a wave to 1,000 cases with reminders, and tracks the funnel', async () => {
    const ids = await addCases(1000, 'W');
    const [optedOut] = await addCases(1, 'OPT', { consent: { email: false } });
    const [suppressedCase] = await addCases(1, 'SUP');
    await t.admin`insert into suppressions (id, tenant_id, email, reason) values (${uuidv7()}, ${tenant.id}, 'sup0@example.org', 'unsubscribe')`;
    const wave = await post(`/projects/${project}/waves`, {
      name: 'Primera ola',
      questionnaireId: qid,
      reminderDays: [3, 7],
      filter: 'case.region >= 0',
    });
    expect(wave.status, JSON.stringify(wave.body)).toBe(201);
    // Nothing goes out until the lawful basis is declared (W4).
    const blocked = await post(`/projects/${project}/waves/${wave.body.id}/send`);
    expect(blocked.body.code).toBe('NO_LAWFUL_BASIS');
    await pm.agent
      .patch(`/api/v1/projects/${project}`)
      .set('x-csrf-token', pm.csrf)
      .send({ settings: { cawi: { lawfulBasis: 'consent', senderName: 'Encuesta de hogares' } } })
      .expect(200);
    const sent = await post(`/projects/${project}/waves/${wave.body.id}/send`);
    expect(sent.body).toEqual({
      queued: 1000,
      skipped: { noEmail: 0, suppressed: 1, optedOut: 1 },
    });
    expect((await post(`/projects/${project}/waves/${wave.body.id}/send`)).status).toBe(409);
    void optedOut;
    void suppressedCase;

    t.mailer.sent.length = 0;
    expect(await drain()).toBe(1000);
    expect(t.mailer.sent).toHaveLength(1000);
    const first = mailsTo('w0@example.org')[0]!;
    expect(first.subject).toBe('Encuesta para Ana0');
    expect(first.fromName).toBe('Encuesta de hogares');
    expect(first.headers!['List-Unsubscribe']).toMatch(/^<http:\/\/survey\.test\/u\//);
    expect(first.html).toContain('/t/o/');
    expect(await drain()).toBe(0);

    // Open, click and start: the funnel moves.
    const token = tokenOf(first.text);
    await api().get(`/api/v1/t/o/${token}.gif`).expect(200).expect('content-type', 'image/gif');
    const click = await api().get(`/api/v1/t/c/${token}`).expect(302);
    expect(click.headers.location).toBe(`http://survey.test/s/${token}`);
    const opened = await api().get(`/api/v1/public/s/${token}?device=browser-phone-1`).expect(200);
    expect(opened.body.interview).toMatchObject({ mode: 'CAWI', language: 'es' });
    expect(opened.body.context.case.first_name).toBe('Ana0');

    // Answer one question, then resume on another device: the answer is there.
    const p = opened.body as {
      interview: { id: string; startedAt: string };
      compiled: CompiledQuestionnaire;
      context: { case: Record<string, unknown> };
    };
    const opts = {
      mode: 'CAWI' as const,
      language: 'es',
      seed: p.interview.id,
      now: () => new Date(p.interview.startedAt),
      context: { case: p.context.case },
    };
    const s = createInterview(p.compiled, opts);
    s.setAnswer('AGE', 41, 'respondent');
    s.next();
    const ops1 = s.drainEvents().map((e, i) => ({
      seq: i + 1,
      kind: 'answer' as const,
      variable: e.key,
      oldValue: e.oldValue,
      newValue: e.newValue,
      at: new Date().toISOString(),
      source: e.source,
      reason: e.reason ?? null,
    }));
    const synced = await api()
      .post(`/api/v1/public/s/${token}/sync`)
      .send({ deviceId: 'browser-phone-1', ops: ops1, state: s.state() });
    expect(synced.body.acks).toEqual({ [p.interview.id]: 1 });
    const resumed = await api()
      .get(`/api/v1/public/s/${token}?device=browser-laptop-1`)
      .expect(200);
    expect(resumed.body.interview.state.answers.AGE).toBe(41);
    expect(resumed.body.lastSeq).toBe(0);
    const s2 = createInterview(p.compiled, { ...opts, state: resumed.body.interview.state });
    expect(s2.currentKey()).toBe('NAME');
    s2.setAnswer('NAME', 'Ana', 'respondent');
    s2.next();
    const ops2 = s2.drainEvents().map((e, i) => ({
      seq: i + 1,
      kind: 'answer' as const,
      variable: e.key,
      oldValue: e.oldValue,
      newValue: e.newValue,
      at: new Date().toISOString(),
      source: e.source,
      reason: e.reason ?? null,
    }));
    await api()
      .post(`/api/v1/public/s/${token}/sync`)
      .send({ deviceId: 'browser-laptop-1', ops: ops2, state: s2.state() })
      .expect(200);
    const done = await api()
      .post(`/api/v1/public/s/${token}/submit`)
      .send({ deviceId: 'browser-laptop-1', seq: ops2.length, path: s2.pathKeys() });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const [c0] = await t.admin`select status, disposition from cases where id = ${ids[0]!}`;
    expect(c0).toMatchObject({ status: 'finalised', disposition: 'COMPLETE' });
    // The link now shows the survey as finished.
    const after = await api().get(`/api/v1/public/s/${token}?device=browser-laptop-1`);
    expect(after.body.interview.status).toBe('submitted');

    // Reminders after 3 days, not to the one who finished.
    await t.admin`update invitations set sent_at = now() - interval '4 days' where wave_id = ${wave.body.id}`;
    t.mailer.sent.length = 0;
    expect(await drain()).toBe(999);
    expect(mailsTo('w0@example.org')).toHaveLength(0);
    expect(mailsTo('w1@example.org')[0]!.subject).toBe('Recordatorio: su opinión es importante');
    expect(await drain()).toBe(0);

    const funnel = (await pm.agent.get(`/api/v1/projects/${project}/waves`)).body[0].funnel;
    expect(funnel).toMatchObject({
      total: 1000,
      sent: 1000,
      opened: 1,
      clicked: 1,
      started: 1,
      completed: 1,
      reminders: 999,
    });
  });

  it('bounces suppress the address and can move the case to telephone; unsubscribing too', async () => {
    const [a, b] = await addCases(2, 'B');
    const wave = await post(`/projects/${project}/waves`, {
      name: 'Rebotes',
      questionnaireId: qid,
      filter: 'case.first_name == "Ana0" or case.first_name == "Ana1"',
      bouncesToCati: true,
    });
    await post(`/projects/${project}/waves/${wave.body.id}/send`).expect(200);
    t.mailer.sent.length = 0;
    await drain();
    const bMail = mailsTo('b0@example.org')[0]!;
    const invitationId = bMail.headers!['X-WanSurvey-Invitation']!;
    // Without the secret: refused.
    await api()
      .post('/api/v1/webhooks/mail')
      .send({ events: [{ invitationId, type: 'bounce', bounceType: 'hard' }] })
      .expect(401);
    const r = await api()
      .post('/api/v1/webhooks/mail')
      .set('x-webhook-secret', SECRET)
      .send({
        events: [
          { invitationId, type: 'bounce', bounceType: 'hard', reason: '550 no such user' },
          {
            invitationId: mailsTo('b1@example.org')[0]!.headers!['X-WanSurvey-Invitation'],
            type: 'delivered',
          },
        ],
      });
    expect(r.body).toEqual({ applied: 2 });
    const [sup] = await t.admin`select reason from suppressions where email = 'b0@example.org'`;
    expect(sup!.reason).toBe('hard_bounce');
    const [ca] =
      await t.admin`select disposition, mode_preference, next_contact_at from cases where id = ${a!}`;
    expect(ca).toMatchObject({ disposition: 'EMAIL_BOUNCED', mode_preference: 'CATI' });
    expect(ca!.next_contact_at).not.toBeNull();
    const funnel = (await pm.agent.get(`/api/v1/projects/${project}/waves`)).body.find(
      (w: { id: string }) => w.id === wave.body.id,
    ).funnel;
    expect(funnel).toMatchObject({ bounced: 1, delivered: 1 });

    // Unsubscribe through the link in the e-mail.
    const unsub = mailsTo('b1@example.org')[0]!.text.match(/\/u\/([A-Za-z0-9_-]+)/)![1]!;
    const info = await api().get(`/api/v1/public/u/${unsub}`).expect(200);
    expect(info.body).toEqual({ email: 'b1•••@example.org', unsubscribed: false });
    await api().post(`/api/v1/public/u/${unsub}`).expect(200);
    const [s2] = await t.admin`select reason from suppressions where email = 'b1@example.org'`;
    expect(s2!.reason).toBe('unsubscribe');
    void b;
    const sups = await pm.agent.get(`/api/v1/projects/${project}/suppressions`);
    expect(sups.body.map((x: { email: string }) => x.email)).toEqual(
      expect.arrayContaining(['b0@example.org', 'b1@example.org']),
    );
  });

  it('an open link starts anonymous interviews; unknown tokens are not found', async () => {
    const link = await put(`/projects/${project}/open-link`, {
      active: true,
      questionnaireId: qid,
    });
    expect(link.body.link.url).toMatch(/^http:\/\/survey\.test\/o\//);
    const slug = link.body.link.slug as string;
    const start = await api().post(`/api/v1/public/o/${slug}/start`).expect(200);
    const s = await api().get(`/api/v1/public/s/${start.body.token}?device=anon-browser-1`);
    expect(s.status).toBe(200);
    expect(s.body.context.case).toEqual({});
    await put(`/projects/${project}/open-link`, { active: false });
    await api().post(`/api/v1/public/o/${slug}/start`).expect(404);
    await api().get('/api/v1/public/s/not-a-real-token-at-all?device=anon-browser-1').expect(404);
  });

  it('a links-only wave makes a personal link per case, e-mail or not, and sends nothing', async () => {
    const ids = await addCases(3, 'LNK');
    // One case without any e-mail still gets its link.
    await t.admin`delete from contacts where case_id = ${ids[2]!}`;
    const w = await post(`/projects/${project}/waves`, {
      name: 'Enlaces',
      questionnaireId: qid,
      channel: 'links',
    }).expect(201);
    const sentBefore = t.mailer.sent.length;
    const made = await post(`/projects/${project}/waves/${w.body.id}/send`).expect(200);
    expect(made.body, JSON.stringify(made.body)).toMatchObject({ queued: 0 });
    expect(made.body.links).toBeGreaterThanOrEqual(3);
    await drain();
    expect(t.mailer.sent.length).toBe(sentBefore);
    const links = await pm.agent
      .get(`/api/v1/projects/${project}/waves/${w.body.id}/links`)
      .expect(200);
    const mine = (links.body as { externalId: string; url: string; status: string }[]).filter((l) =>
      l.externalId.startsWith('LNK'),
    );
    expect(mine).toHaveLength(3);
    expect(mine[0]!.url).toMatch(/^http:\/\/survey\.test\/s\/[A-Za-z0-9_-]+$/);
    // The link opens the survey for its own case.
    const token = mine[2]!.url.split('/s/')[1]!;
    const s = await api().get(`/api/v1/public/s/${token}?device=link-browser-1`).expect(200);
    expect(s.body.context.case).toMatchObject({ first_name: 'Ana2' });
    const again = await pm.agent.get(`/api/v1/projects/${project}/waves/${w.body.id}/links`);
    expect(
      (again.body as { externalId: string; status: string }[]).find(
        (l) => l.externalId === 'LNK0002',
      )?.status,
    ).toBe('started');
  });
});
