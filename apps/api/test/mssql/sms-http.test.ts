import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WaveDispatcher } from '../../src/cawi/dispatcher.js';
import { resetConfigCache } from '../../src/config.js';
import { MemorySms, SMS_PROVIDER } from '../../src/sms/sms.js';
import { createQuestionnaire, patch, post, get } from './fixtures.js';
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
  id: 'SMS',
  title: { es: 'SMS' },
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
const SECRET = 'sms-webhook-secret-1234567890';

/** Web surveys by SMS: the plan and its cost, consent, calling hours, STOP (ADR 0001, decision 4). */
describe.skipIf(!configured)('SQL Server: web surveys by SMS over HTTP', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let pm: Session;
  let sms: MemorySms;
  let dispatcher: WaveDispatcher;
  let phone = 0;

  beforeAll(async () => {
    process.env.SMS_WEBHOOK_SECRET = SECRET;
    process.env.SMS_CONFIRM_ABOVE = '3';
    process.env.SMS_PRICE_PER_SEGMENT = '0.5';
    process.env.PUBLIC_URL = 'http://survey.test';
    resetConfigCache();
    t = await bootstrap();
    sms = t.app.get<MemorySms>(SMS_PROVIDER);
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
    for (const k of [
      'SMS_WEBHOOK_SECRET',
      'SMS_CONFIRM_ABOVE',
      'SMS_PRICE_PER_SEGMENT',
      'PUBLIC_URL',
    ])
      delete process.env[k];
    resetConfigCache();
    await t?.close();
  });

  const api = () => request(t.app.getHttpServer());
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;
  const hours = (from: string, to: string) =>
    patch(pm, `/projects/${project}`, {
      settings: { cawi: { lawfulBasis: 'consent' }, cati: { callingHours: { from, to } } },
    });
  const allDay = () => hours('00:00', '00:00');
  /** A window of one hour, twelve hours away from now. */
  const closedNow = () => {
    const h = (new Date().getUTCHours() + 12) % 24;
    return hours(`${String(h).padStart(2, '0')}:00`, `${String((h + 1) % 24).padStart(2, '0')}:00`);
  };

  async function addCase(prefix: string, contact: { value?: string; consent?: object } | null) {
    const id = randomUUID();
    await sql`INSERT INTO cases (id, tenant_id, project_id, external_id, sample, status)
              VALUES (${id}, ${tenant.id}, ${project}, ${prefix + id.slice(0, 6)},
                ${JSON.stringify({ first_name: 'Rosa' })}, 'fresh')`.execute(t.owner);
    if (contact)
      await sql`INSERT INTO contacts (id, tenant_id, case_id, type, value, consent)
                VALUES (${randomUUID()}, ${tenant.id}, ${id}, 'phone',
                  ${contact.value ?? `+5198700${String(++phone).padStart(4, '0')}`},
                  ${JSON.stringify(contact.consent ?? {})})`.execute(t.owner);
    return id;
  }
  const waveOf = async (channel: string, name = 'Ola SMS') =>
    (
      await post(pm, `/projects/${project}/waves`, {
        name,
        questionnaireId: qid,
        channel,
        reminderDays: [3],
      })
    ).body.id as string;
  async function drain() {
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const n = await dispatcher.tick();
      total += n;
      if (!n) break;
    }
    return total;
  }

  it('needs the lawful basis, and plans only the numbers it may write to', async () => {
    const wave = await waveOf('sms');
    const noBasis = await post(pm, `/projects/${project}/waves/${wave}/send`, {});
    expect(noBasis.body.code).toBe('NO_LAWFUL_BASIS');
    await allDay();

    await addCase('OK', {});
    await addCase('OK', {});
    await addCase('NONE', null);
    await addCase('BAD', { value: '987654321' });
    await addCase('OPT', { consent: { sms: false } });
    const stopped = '+51999000111';
    await addCase('SUP', { value: stopped });
    await sql`INSERT INTO suppressions (id, tenant_id, email, reason) VALUES (${randomUUID()}, ${tenant.id}, ${stopped}, 'unsubscribe')`.execute(
      t.owner,
    );

    const preview = await get(pm, `/projects/${project}/waves/${wave}/preview`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({
      recipients: 2,
      skipped: { noPhone: 1, badNumber: 1, suppressed: 1, optedOut: 1 },
      reminders: 1,
      needsConfirmation: false,
    });
    // Two recipients, an invitation and one reminder each, at 0.5 a segment.
    expect(preview.body.estimatedSegments).toBe(4 * preview.body.segmentsPerMessage);
    expect(preview.body.estimatedCost).toBe(preview.body.estimatedSegments * 0.5);

    sms.sent.length = 0;
    const sent = await post(pm, `/projects/${project}/waves/${wave}/send`, {});
    expect(sent.body).toEqual({
      queued: 2,
      skipped: { noPhone: 1, badNumber: 1, suppressed: 1, optedOut: 1 },
    });
    expect(await drain()).toBe(2);
    expect(sms.sent).toHaveLength(2);
    expect(t.mailer.sent.filter((m) => m.to.startsWith('+'))).toHaveLength(0);
    const first = sms.sent[0]!;
    expect(first.to).toMatch(/^\+5198700/);
    expect(first.text).toMatch(/http:\/\/survey\.test\/api\/v1\/t\/c\/[\w-]+/);
    expect(first.text).toContain('BAJA');
    expect(first.text).toContain('Rosa');
    // Not sent twice.
    expect(await drain()).toBe(0);
    // The link opens the survey like an e-mailed one.
    const token = first.text.match(/\/t\/c\/([\w-]+)/)![1]!;
    expect((await api().get(`/api/v1/t/c/${token}`)).status).toBe(302);
  });

  it('asks for a second confirmation above the threshold', async () => {
    for (let i = 0; i < 4; i++) await addCase('BIG', {});
    const wave = await waveOf('sms', 'Ola grande');
    const preview = await get(pm, `/projects/${project}/waves/${wave}/preview`);
    expect(preview.body.needsConfirmation).toBe(true);
    const refused = await post(pm, `/projects/${project}/waves/${wave}/send`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CONFIRM_REQUIRED');
    const wavesAfter = await get(pm, `/projects/${project}/waves`);
    expect(wavesAfter.body.find((w: { id: string }) => w.id === wave).status).toBe('draft');
    const ok = await post(pm, `/projects/${project}/waves/${wave}/send`, { confirm: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.queued).toBeGreaterThan(3);
  });

  it('waits for the calling hours of the respondent', async () => {
    await drain();
    await closedNow();
    const id = await addCase('LATE', { value: '+51988000777' });
    const wave = await waveOf('sms', 'Ola nocturna');
    const filtered = await post(pm, `/projects/${project}/waves/${wave}/send`, { confirm: true });
    expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
    sms.sent.length = 0;
    expect(await drain()).toBe(0);
    expect(sms.sent.filter((m) => m.to === '+51988000777')).toHaveLength(0);
    const [inv] = await rows(
      sql`SELECT status, send_attempts FROM invitations WHERE case_id = ${id}`,
    );
    expect(inv).toMatchObject({ status: 'queued', send_attempts: 0 });
    // When the window opens, it goes.
    await allDay();
    await drain();
    expect(sms.sent.filter((m) => m.to === '+51988000777')).toHaveLength(1);
  });

  it('tries again when the provider is down, and marks it failed after the last try', async () => {
    const id = await addCase('FAIL', { value: '+51988000888' });
    const wave = await waveOf('sms', 'Ola caída');
    await post(pm, `/projects/${project}/waves/${wave}/send`, { confirm: true });
    sms.failWith = new Error('provider down');
    for (let i = 0; i < 6; i++) await dispatcher.tick();
    sms.failWith = null;
    const [inv] = await rows(sql`SELECT status, last_error FROM invitations WHERE case_id = ${id}`);
    expect(inv).toMatchObject({ status: 'failed', last_error: 'provider down' });
  });

  it('adds a number to the list of those never written to again when it replies STOP', async () => {
    const number = '+51988000999';
    await addCase('STOPME', { value: number });
    const wave = await waveOf('sms', 'Ola stop');
    await post(pm, `/projects/${project}/waves/${wave}/send`, { confirm: true });
    const hook = (body: object, secret: string | null = SECRET) =>
      api()
        .post('/api/v1/webhooks/sms')
        .set(secret ? { 'x-webhook-secret': secret } : {})
        .send(body);
    expect((await hook({ from: number, text: 'STOP' }, 'wrong')).status).toBe(401);
    expect((await hook({ from: number, text: 'STOP' }, null)).status).toBe(401);
    // Any other reply does nothing.
    expect((await hook({ from: number, text: 'gracias' })).body).toEqual({ optedOut: 0 });
    const stop = await hook({ from: number.replace('+51', '+51 '), text: ' Baja ' });
    expect(stop.status).toBe(200);
    expect(stop.body).toEqual({ optedOut: 1 });
    const [s] = await rows(sql`SELECT reason FROM suppressions WHERE email = ${number}`);
    expect(s!.reason).toBe('unsubscribe');
    // The invitation still waiting for it is not sent.
    sms.sent.length = 0;
    await drain();
    expect(sms.sent.filter((m) => m.to === number)).toHaveLength(0);
    // And another wave skips the number.
    await addCase('STOPME2', { value: number });
    const wave2 = await waveOf('sms', 'Otra ola');
    const preview = await get(pm, `/projects/${project}/waves/${wave2}/preview`);
    expect(preview.body.skipped.suppressed).toBeGreaterThanOrEqual(1);
  });

  it('keeps e-mail waves as they were, and refuses a preview for them', async () => {
    const wave = await waveOf('email', 'Correo');
    expect((await get(pm, `/projects/${project}/waves/${wave}/preview`)).status).toBe(400);
  });
});
