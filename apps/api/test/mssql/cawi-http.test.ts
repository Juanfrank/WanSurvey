import { createInterview, type CompiledQuestionnaire } from '@wansurvey/logic';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WaveDispatcher } from '../../src/cawi/dispatcher.js';
import { resetConfigCache } from '../../src/config.js';
import { createQuestionnaire, get, patch, post, put } from './fixtures.js';
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
          personal: true,
          text: { es: '¿Su nombre, {{case.first_name}}?' },
        },
      ],
    },
  ],
};
const SECRET = 'webhook-secret-1234567890';

/**
 * Web surveys by e-mail over HTTP on SQL Server: templates,
 * a wave sent in batches with reminders, tracking, the respondent resuming on another device,
 * bounces and unsubscribing, the open link, and links-only waves.
 */
describe.skipIf(!configured)('SQL Server: web surveys by e-mail over HTTP', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
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
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    qid = await createQuestionnaire(t.owner, tenant.id, project, { definition, publish: true });
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager', projectId: project }]),
      tenant.slug,
    );
  });
  afterAll(async () => {
    delete process.env.MAIL_WEBHOOK_SECRET;
    delete process.env.PUBLIC_WEB_URL;
    resetConfigCache();
    await t?.close();
  });

  const api = () => request(t.app.getHttpServer());
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;

  /** Adds cases with an e-mail each. */
  async function addCases(
    n: number,
    prefix: string,
    extra: { consent?: Record<string, boolean> } = {},
  ) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      ids.push(id);
      await sql`INSERT INTO cases (id, tenant_id, project_id, external_id, sample, status)
                VALUES (${id}, ${tenant.id}, ${project},
                  ${`${prefix}${String(i).padStart(4, '0')}`},
                  ${JSON.stringify({ first_name: `Ana${i}`, region: i % 3 })}, 'fresh')`.execute(
        t.owner,
      );
      await sql`INSERT INTO contacts (id, tenant_id, case_id, type, value, consent)
                VALUES (${randomUUID()}, ${tenant.id}, ${id}, 'email',
                  ${`${prefix.toLowerCase()}${i}@example.org`}, ${JSON.stringify(extra.consent ?? {})})`.execute(
        t.owner,
      );
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
  const ops = (s: ReturnType<typeof createInterview>) =>
    s.drainEvents().map((e, i) => ({
      seq: i + 1,
      kind: 'answer' as const,
      variable: e.key,
      oldValue: e.oldValue,
      newValue: e.newValue,
      at: new Date().toISOString(),
      source: e.source,
      reason: e.reason ?? null,
    }));

  it('words e-mails with checked placeholders, Spanish by default', async () => {
    const list = await get(pm, `/projects/${project}/email-templates`);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'invitation', language: 'es', custom: false }),
      ]),
    );
    const bad = await put(pm, `/projects/${project}/email-templates`, {
      kind: 'invitation',
      language: 'es',
      subject: 'Hola',
      body: 'Hola {{foo}} {{link}}',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.problems).toEqual(['foo', 'missing:unsubscribe']);
    const ok = await put(pm, `/projects/${project}/email-templates`, {
      kind: 'invitation',
      language: 'es',
      subject: 'Encuesta para {{case.first_name}}',
      body: 'Hola {{case.first_name}}: {{link}}\nBaja: {{unsubscribe}}',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const again = await get(pm, `/projects/${project}/email-templates`);
    expect(
      again.body.find(
        (x: { kind: string; language: string }) => x.kind === 'invitation' && x.language === 'es',
      ),
    ).toMatchObject({ custom: true, subject: 'Encuesta para {{case.first_name}}' });
  });

  it('sends a wave with reminders, resumes the respondent elsewhere, and tracks the funnel', async () => {
    const N = 40;
    const ids = await addCases(N, 'W');
    await addCases(1, 'OPT', { consent: { email: false } });
    await addCases(1, 'SUP');
    await sql`INSERT INTO suppressions (id, tenant_id, email, reason) VALUES (${randomUUID()}, ${tenant.id}, 'sup0@example.org', 'unsubscribe')`.execute(
      t.owner,
    );
    const wave = await post(pm, `/projects/${project}/waves`, {
      name: 'Primera ola',
      questionnaireId: qid,
      reminderDays: [3, 7],
      filter: 'case.region >= 0',
    });
    expect(wave.status, JSON.stringify(wave.body)).toBe(201);
    // Nothing goes out until the lawful basis is declared (W4).
    const blocked = await post(pm, `/projects/${project}/waves/${wave.body.id}/send`);
    expect(blocked.body.code).toBe('NO_LAWFUL_BASIS');
    const settings = await patch(pm, `/projects/${project}`, {
      settings: { cawi: { lawfulBasis: 'consent', senderName: 'Encuesta de hogares' } },
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    const sent = await post(pm, `/projects/${project}/waves/${wave.body.id}/send`);
    expect(sent.body, JSON.stringify(sent.body)).toEqual({
      queued: N,
      skipped: { noEmail: 0, suppressed: 1, optedOut: 1 },
    });
    expect((await post(pm, `/projects/${project}/waves/${wave.body.id}/send`)).status).toBe(409);

    t.mailer.sent.length = 0;
    expect(await drain()).toBe(N);
    expect(t.mailer.sent).toHaveLength(N);
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
    const opened = await api().get(`/api/v1/public/s/${token}?device=browser-phone-1`);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
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
    const synced = await api()
      .post(`/api/v1/public/s/${token}/sync`)
      .send({ deviceId: 'browser-phone-1', ops: ops(s), state: s.state() });
    expect(synced.body.acks).toEqual({ [p.interview.id]: 1 });
    const resumed = await api().get(`/api/v1/public/s/${token}?device=browser-laptop-1`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.interview.state.answers.AGE).toBe(41);
    expect(resumed.body.lastSeq).toBe(0);
    const s2 = createInterview(p.compiled, { ...opts, state: resumed.body.interview.state });
    expect(s2.currentKey()).toBe('NAME');
    s2.setAnswer('NAME', 'Ana', 'respondent');
    s2.next();
    const ops2 = ops(s2);
    const synced2 = await api()
      .post(`/api/v1/public/s/${token}/sync`)
      .send({ deviceId: 'browser-laptop-1', ops: ops2, state: s2.state() });
    expect(synced2.status, JSON.stringify(synced2.body)).toBe(200);
    const done = await api()
      .post(`/api/v1/public/s/${token}/submit`)
      .send({ deviceId: 'browser-laptop-1', seq: ops2.length, path: s2.pathKeys() });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const [c0] = await rows(sql`SELECT status, disposition FROM cases WHERE id = ${ids[0]!}`);
    expect(c0).toMatchObject({ status: 'finalised', disposition: 'COMPLETE' });
    // The link now shows the survey as finished.
    const after = await api().get(`/api/v1/public/s/${token}?device=browser-laptop-1`);
    expect(after.body.interview.status).toBe('submitted');

    // Reminders after 3 days, not to the one who finished.
    await sql`UPDATE invitations SET sent_at = DATEADD(day, -4, SYSDATETIMEOFFSET()) WHERE wave_id = ${wave.body.id}`.execute(
      t.owner,
    );
    t.mailer.sent.length = 0;
    expect(await drain()).toBe(N - 1);
    expect(mailsTo('w0@example.org')).toHaveLength(0);
    expect(mailsTo('w1@example.org')[0]!.subject).toBe('Recordatorio: su opinión es importante');
    expect(await drain()).toBe(0);

    const waves = await get(pm, `/projects/${project}/waves`);
    const funnel = waves.body.find((w: { id: string }) => w.id === wave.body.id).funnel;
    expect(funnel).toMatchObject({
      total: N,
      sent: N,
      opened: 1,
      clicked: 1,
      started: 1,
      completed: 1,
      reminders: N - 1,
    });
  });

  it('bounces suppress the address and can move the case to telephone; unsubscribing too', async () => {
    const [a] = await addCases(2, 'B');
    const wave = await post(pm, `/projects/${project}/waves`, {
      name: 'Rebotes',
      questionnaireId: qid,
      filter: 'case.first_name == "Ana0" or case.first_name == "Ana1"',
      bouncesToCati: true,
    });
    // Only the two new cases are in this wave's rule among the not-yet-invited ones.
    expect((await post(pm, `/projects/${project}/waves/${wave.body.id}/send`)).status).toBe(200);
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
    expect(r.body, JSON.stringify(r.body)).toEqual({ applied: 2 });
    const [sup] = await rows(sql`SELECT reason FROM suppressions WHERE email = 'b0@example.org'`);
    expect(sup!.reason).toBe('hard_bounce');
    const [ca] = await rows(
      sql`SELECT disposition, mode_preference, next_contact_at FROM cases WHERE id = ${a!}`,
    );
    expect(ca).toMatchObject({ disposition: 'EMAIL_BOUNCED', mode_preference: 'CATI' });
    expect(ca!.next_contact_at).not.toBeNull();
    const waves = await get(pm, `/projects/${project}/waves`);
    const funnel = waves.body.find((w: { id: string }) => w.id === wave.body.id).funnel;
    expect(funnel).toMatchObject({ bounced: 1, delivered: 1 });

    // Unsubscribe through the link in the e-mail.
    const unsub = mailsTo('b1@example.org')[0]!.text.match(/\/u\/([A-Za-z0-9_-]+)/)![1]!;
    const info = await api().get(`/api/v1/public/u/${unsub}`);
    expect(info.body).toEqual({ email: 'b1•••@example.org', unsubscribed: false });
    expect((await api().post(`/api/v1/public/u/${unsub}`)).status).toBe(200);
    const [s2] = await rows(sql`SELECT reason FROM suppressions WHERE email = 'b1@example.org'`);
    expect(s2!.reason).toBe('unsubscribe');
    const sups = await get(pm, `/projects/${project}/suppressions`);
    expect(sups.body.map((x: { email: string }) => x.email)).toEqual(
      expect.arrayContaining(['b0@example.org', 'b1@example.org']),
    );
  });

  it('an open link starts anonymous interviews; unknown tokens are not found', async () => {
    const link = await put(pm, `/projects/${project}/open-link`, {
      active: true,
      questionnaireId: qid,
    });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect(link.body.link.url).toMatch(/^http:\/\/survey\.test\/o\//);
    const slug = link.body.link.slug as string;
    const start = await api().post(`/api/v1/public/o/${slug}/start`);
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const s = await api().get(`/api/v1/public/s/${start.body.token}?device=anon-browser-1`);
    expect(s.status).toBe(200);
    expect(s.body.context.case).toEqual({});
    await put(pm, `/projects/${project}/open-link`, { active: false });
    expect((await api().post(`/api/v1/public/o/${slug}/start`)).status).toBe(404);
    expect(
      (await api().get('/api/v1/public/s/not-a-real-token-at-all?device=anon-browser-1')).status,
    ).toBe(404);
  });

  it('a links-only wave makes a personal link per case, e-mail or not, and sends nothing', async () => {
    const ids = await addCases(3, 'LNK');
    // One case without any e-mail still gets its link.
    await sql`DELETE FROM contacts WHERE case_id = ${ids[2]!}`.execute(t.owner);
    const w = await post(pm, `/projects/${project}/waves`, {
      name: 'Enlaces',
      questionnaireId: qid,
      channel: 'links',
    });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    const sentBefore = t.mailer.sent.length;
    const made = await post(pm, `/projects/${project}/waves/${w.body.id}/send`);
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({ queued: 0 });
    expect(made.body.links).toBeGreaterThanOrEqual(3);
    await drain();
    expect(t.mailer.sent.length).toBe(sentBefore);
    const links = await get(pm, `/projects/${project}/waves/${w.body.id}/links`);
    expect(links.status).toBe(200);
    const mine = (links.body as { externalId: string; url: string; status: string }[]).filter((l) =>
      l.externalId.startsWith('LNK'),
    );
    expect(mine).toHaveLength(3);
    expect(mine[0]!.url).toMatch(/^http:\/\/survey\.test\/s\/[A-Za-z0-9_-]+$/);
    // The link opens the survey for its own case.
    const token = mine[2]!.url.split('/s/')[1]!;
    const s = await api().get(`/api/v1/public/s/${token}?device=link-browser-1`);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.context.case).toMatchObject({ first_name: 'Ana2' });
    const again = await get(pm, `/projects/${project}/waves/${w.body.id}/links`);
    expect(
      (again.body as { externalId: string; status: string }[]).find(
        (l) => l.externalId === mine[2]!.externalId,
      )!.status,
    ).toBe('started');
  });
});
