import { randomUUID } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../../src/auth/auth.service.js';
import { WaveDispatcher } from '../../src/cawi/dispatcher.js';
import { createApp } from '../../src/app.js';
import { resetConfigCache } from '../../src/config.js';
import { Engine } from '../../src/db/engine.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { MemoryMailer } from '../../src/mail/mailer.js';
import { PrivacyService } from '../../src/privacy/privacy.service.js';
import { Tenancy } from '../../src/tenants/tenancy.js';
import { createQuestionnaire, patch, post, put } from './fixtures.js';
import {
  ADMIN_URL,
  APP_URL,
  configured,
  createProject,
  createUser,
  login as signIn,
  PASSWORD,
  type MssqlTestApp,
  type Session,
  type TestUser,
} from './harness.js';

const ENTRA_TENANT = randomUUID();
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DAY = 86_400_000;
const MAIL_SECRET = 'single-tenant-mail-secret-123';

const definition = {
  id: 'ONE',
  title: { es: 'Una' },
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

/**
 * SINGLE_TENANT=true, on a database of its own (the number of organisations matters): the routes
 * that exist only with several organisations answer 404, sign-in and the Microsoft start always
 * open the one, a new installation serves its first organisation once it appears, and a database
 * with several serves one (SINGLE_TENANT_ORG, or the oldest) and closes every door of the others:
 * sign-in, sessions, API keys, web-survey, feedback and share links, and the worker's jobs. Without
 * the setting everything opens again, with nothing done by hand.
 */
describe.skipIf(!configured)('SQL Server: single-tenant mode', () => {
  const name = `ws_single_${Date.now().toString(36)}`;
  const at = (url: string, database: string) => {
    const u = new URL(url);
    u.pathname = `/${database}`;
    return u.toString();
  };
  const master = createMssqlDb<Record<string, never>>(at(ADMIN_URL ?? 'mssql://x@y/z', 'master'), {
    max: 1,
  });
  const adminUrl = ADMIN_URL ? at(ADMIN_URL, name) : '';
  const appUrl = APP_URL ? at(APP_URL, name) : '';
  let owner: ReturnType<typeof createMssqlDb<Record<string, never>>>;
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    'DATABASE_URL',
    'DATABASE_ADMIN_URL',
    'SINGLE_TENANT',
    'SINGLE_TENANT_ORG',
    'PASSWORD_2FA_REQUIRED',
    'MAIL_WEBHOOK_SECRET',
  ];
  const apps: INestApplication[] = [];
  const mailers = new Map<INestApplication, MemoryMailer>();

  /** Starts the application on the test database, in single-tenant mode or not. */
  async function start(single: boolean, org?: string) {
    if (single) process.env.SINGLE_TENANT = 'true';
    else delete process.env.SINGLE_TENANT;
    if (org) process.env.SINGLE_TENANT_ORG = org;
    else delete process.env.SINGLE_TENANT_ORG;
    // Another file of the suite may have left the production rule on.
    process.env.PASSWORD_2FA_REQUIRED = 'false';
    process.env.MAIL_WEBHOOK_SECRET = MAIL_SECRET;
    resetConfigCache();
    const mailer = new MemoryMailer();
    const made = await createApp({ mailer });
    try {
      await made.init();
    } catch (e) {
      await made.close().catch(() => undefined);
      throw e;
    }
    apps.push(made);
    mailers.set(made, mailer);
    return made;
  }
  /** The harness's view of an application, for its sign-in with a second factor. */
  const harness = (a: INestApplication) =>
    ({ app: a, owner, mailer: mailers.get(a)!, close: async () => undefined }) as MssqlTestApp;

  async function org(slug: string, createdAt: Date) {
    const id = randomUUID();
    await sql`INSERT INTO tenants (id, name, slug, created_at)
              VALUES (${id}, ${slug}, ${slug}, ${createdAt.toISOString()})`.execute(owner);
    return { id: id.toLowerCase(), slug };
  }

  /** An interviewer (no second factor) in each of these organisations. */
  async function person(email: string, tenantIds: string[]) {
    const id = randomUUID();
    await sql`INSERT INTO users (id, email, name, status, password_hash)
              VALUES (${id}, ${email}, ${email}, 'active', ${await hashPassword(PASSWORD)})`.execute(
      owner,
    );
    for (const t of tenantIds) {
      await sql`INSERT INTO tenant_members (id, tenant_id, user_id, status)
                VALUES (${randomUUID()}, ${t}, ${id}, 'active')`.execute(owner);
      await sql`INSERT INTO memberships (id, tenant_id, user_id, role)
                VALUES (${randomUUID()}, ${t}, ${id}, 'interviewer')`.execute(owner);
    }
    return { id, email };
  }

  const login = (a: INestApplication, email: string, tenant?: string) => {
    const agent = request.agent(a.getHttpServer());
    return agent
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD, ...(tenant ? { tenant } : {}) })
      .then((res) => ({ agent, res, csrf: res.body.csrfToken as string }));
  };

  beforeAll(async () => {
    await sql.raw(`CREATE DATABASE [${name}]`).execute(master);
    await runMssqlMigrations(adminUrl, appUrl);
    owner = createMssqlDb<Record<string, never>>(adminUrl, { max: 2 });
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { DATABASE_URL: appUrl, DATABASE_ADMIN_URL: adminUrl });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const a of apps.splice(0)) await a.close();
    mailers.clear();
  });
  afterAll(async () => {
    await owner.destroy();
    await sql
      .raw(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`)
      .execute(master);
    await sql.raw(`DROP DATABASE [${name}]`).execute(master);
    await master.destroy();
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    resetConfigCache();
  });

  let first: { id: string; slug: string };
  let second: { id: string; slug: string };
  const ana = 'ana@single.test';
  const both = 'both@single.test';
  const ids = (list: { id: string }[]) => list.map((t) => t.id);

  it('a new installation starts with no organisation and serves the first once it exists', async () => {
    const a = await start(true);
    const methods = await request(a.getHttpServer()).get('/api/v1/auth/methods');
    expect(methods.body).toMatchObject({
      password: true,
      microsoftNeedsEmail: false,
      singleTenant: true,
    });
    // Nobody to sign in yet; then the first organisation is made (as INITIAL_ADMIN_USER does).
    expect((await login(a, ana)).res.status).toBe(401);
    first = await org('first', new Date(Date.now() - 30 * DAY));
    await person(ana, [first.id]);
    // There is no organisation to choose: whatever is asked for, the one opens.
    const { agent, res, csrf } = await login(a, ana, 'elsewhere');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tenant.id).toBe(first.id);
    expect(ids(res.body.tenants)).toEqual([first.id]);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.singleTenant).toBe(true);
    expect(ids(me.body.tenants)).toEqual([first.id]);
    // The routes about several organisations do not exist here.
    const list = await agent.get('/api/v1/auth/tenants');
    expect(list.status).toBe(404);
    expect(list.body.code).toBe('SINGLE_TENANT');
    const sw = await agent
      .post('/api/v1/auth/switch-tenant')
      .set('x-csrf-token', csrf)
      .send({ tenantId: first.id });
    expect(sw.status).toBe(404);
    expect(sw.body.code).toBe('SINGLE_TENANT');
  });

  it('Microsoft sign-in starts in the one organisation, with no e-mail or organisation given', async () => {
    await sql`
      INSERT INTO tenant_sso (tenant_id, entra_tenant_id, client_id, client_secret_enc, enabled, allowed_domains)
      VALUES (${first.id}, ${ENTRA_TENANT}, ${CLIENT_ID}, NULL, 1, ${JSON.stringify(['single.test'])})`.execute(
      owner,
    );
    const a = await start(true);
    for (const query of [{}, { org: 'other' }, { email: 'x@elsewhere.org' }]) {
      const res = await request(a.getHttpServer()).get('/api/v1/auth/sso/start').query(query);
      expect(res.status).toBe(302);
      const to = new URL(res.headers.location!);
      expect(to.pathname).toBe(`/${ENTRA_TENANT}/oauth2/v2.0/authorize`);
      expect(to.searchParams.get('client_id')).toBe(CLIENT_ID);
    }
  });

  it('an organisation made after the start is never served; the default mode lists and switches', async () => {
    const single = await start(true);
    second = await org('second', new Date(Date.now() - DAY));
    await person(both, [first.id, second.id]);
    // Without the setting: both organisations, the choice at sign-in and the switch.
    const multi = await start(false);
    const methods = await request(multi.getHttpServer()).get('/api/v1/auth/methods');
    expect(methods.body).toMatchObject({
      password: true,
      microsoftNeedsEmail: true,
      singleTenant: false,
    });
    const m = await login(multi, both, 'second');
    expect(m.res.status, JSON.stringify(m.res.body)).toBe(200);
    expect(m.res.body.tenant.id).toBe(second.id);
    expect(m.res.body.tenants).toHaveLength(2);
    expect((await m.agent.get('/api/v1/auth/me')).body.singleTenant).toBe(false);
    expect((await m.agent.get('/api/v1/auth/tenants')).body).toHaveLength(2);
    const cookies = m.res.headers['set-cookie'] as unknown as string[];
    // The single-tenant instance keeps serving the first: the second's session has ended there,
    // and signing in to the second opens the first.
    const stale = await request(single.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookies);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('SESSION_EXPIRED');
    const s = await login(single, both, 'second');
    expect(s.res.body.tenant.id).toBe(first.id);
    expect(ids(s.res.body.tenants)).toEqual([first.id]);
    // Back in the default mode the switch works.
    const sw = await m.agent
      .post('/api/v1/auth/switch-tenant')
      .set('x-csrf-token', m.csrf)
      .send({ tenantId: first.id });
    expect(sw.status).toBe(200);
    expect(sw.body.tenant.id).toBe(first.id);
  });

  it('a database with several organisations starts and serves the oldest, with a warning', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const a = await start(true);
    expect(await a.get(Tenancy).tenantId()).toBe(first.id);
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('SINGLE_TENANT_ORG is not set: serving the oldest, first');
    expect(warned).toContain('the database has 2 organisations; 1 other is closed');
    expect((await login(a, both)).res.body.tenant.id).toBe(first.id);
  });

  it('SINGLE_TENANT_ORG chooses the organisation by slug or id; one the database lacks stops the start', async () => {
    const bySlug = await start(true, 'SECOND');
    expect(await bySlug.get(Tenancy).tenantId()).toBe(second.id);
    const s = await login(bySlug, both, 'first');
    expect(s.res.body.tenant.id).toBe(second.id);
    expect(ids(s.res.body.tenants)).toEqual([second.id]);
    // Ana is only in the first: here she has no account at all.
    expect((await login(bySlug, ana)).res.status).toBe(401);
    const byId = await start(true, first.id.toUpperCase());
    expect(await byId.get(Tenancy).tenantId()).toBe(first.id);
    await expect(start(true, 'nowhere')).rejects.toThrow(
      'SINGLE_TENANT_ORG=nowhere, but the database has no organisation with that slug or id',
    );
  });

  describe('every door of the other organisations is closed, and opens again without the mode', () => {
    /** What each organisation has: people, a key, links and mail waiting. */
    interface Org {
      tenant: { id: string; slug: string };
      project: string;
      pm: TestUser;
      ownerUser: TestUser;
      key: string;
      survey: string;
      openSlug: string;
      feedbackSlug: string;
      share: string;
      cookies: string[];
      qid: string;
      session: Session;
    }
    const made: Partial<Record<'a' | 'b', Org>> = {};
    const tokenOf = (text: string) => text.match(/\/t\/c\/([A-Za-z0-9_-]+)/)![1]!;

    /** One case with an e-mail and a wave for it, sent (queued for the dispatcher). */
    async function wave(s: Session, tenantId: string, project: string, qid: string, mail: string) {
      const caseId = randomUUID();
      await sql`INSERT INTO cases (id, tenant_id, project_id, external_id, sample, status)
                VALUES (${caseId}, ${tenantId}, ${project}, ${mail}, ${JSON.stringify({ tag: mail })}, 'fresh')`.execute(
        owner,
      );
      await sql`INSERT INTO contacts (id, tenant_id, case_id, type, value, consent)
                VALUES (${randomUUID()}, ${tenantId}, ${caseId}, 'email', ${mail}, '{}')`.execute(
        owner,
      );
      const w = await post(s, `/projects/${project}/waves`, {
        name: `Ola ${mail}`,
        questionnaireId: qid,
        filter: `case.tag == "${mail}"`,
      });
      expect(w.status, JSON.stringify(w.body)).toBe(201);
      const sent = await post(s, `/projects/${project}/waves/${w.body.id}/send`);
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(sent.body.queued).toBe(1);
    }

    /** Everything an organisation needs, made in the default mode through the API. */
    async function equip(
      a: INestApplication,
      tenant: { id: string; slug: string },
      tag: string,
    ): Promise<Org> {
      const h = harness(a);
      const project = await createProject(owner as never, tenant.id);
      const qid = await createQuestionnaire(owner as never, tenant.id, project, {
        definition,
        publish: true,
      });
      const pm = await createUser(owner as never, tenant.id, [{ role: 'project_manager' }], {
        email: `pm-${tag}@single.test`,
      });
      const ownerUser = await createUser(owner as never, tenant.id, [{ role: 'owner' }], {
        email: `owner-${tag}@single.test`,
      });
      const pmS = await signIn(h, pm, tenant.slug);
      const ownS = await signIn(h, ownerUser, tenant.slug);
      const key = await ownS.agent
        .post('/api/v1/api-keys')
        .set('x-csrf-token', ownS.csrf)
        .send({
          name: 'BI',
          scopes: ['projects:read'],
          expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
        });
      expect(key.status, JSON.stringify(key.body)).toBe(201);
      const settings = await patch(pmS, `/projects/${project}`, {
        settings: { cawi: { lawfulBasis: 'consent' } },
      });
      expect(settings.status, JSON.stringify(settings.body)).toBe(200);
      const open = await put(pmS, `/projects/${project}/open-link`, {
        active: true,
        questionnaireId: qid,
      });
      expect(open.status, JSON.stringify(open.body)).toBe(200);
      const fb = await pmS.agent
        .post(`/api/v1/projects/${project}/feedback`)
        .set('x-csrf-token', pmS.csrf)
        .send({ name: 'Ventanilla', question: { es: '¿Qué tal?' }, faces: 3 });
      expect(fb.status, JSON.stringify(fb.body)).toBe(201);
      const share = await post(pmS, `/projects/${project}/share-links`, { days: 7 });
      expect(share.status, JSON.stringify(share.body)).toBe(201);
      // A personal web-survey link: a wave sent and dispatched now.
      await wave(pmS, tenant.id, project, qid, `resp-${tag}@example.org`);
      const mailer = mailers.get(a)!;
      await a.get(WaveDispatcher).tick();
      const mail = mailer.sent.find((m) => m.to === `resp-${tag}@example.org`);
      expect(mail, 'invitation sent').toBeTruthy();
      const pmLogin = await request(a.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: pm.email, password: PASSWORD });
      return {
        tenant,
        project,
        pm,
        ownerUser,
        key: key.body.key as string,
        survey: tokenOf(mail!.text),
        openSlug: open.body.link.slug as string,
        feedbackSlug: fb.body.slug as string,
        share: (share.body.url as string).split('/share/')[1]!,
        cookies: pmLogin.headers['set-cookie'] as unknown as string[],
        qid,
        session: pmS,
      };
    }

    /** What each public and signed-in door answers for an organisation. */
    async function doors(a: INestApplication, o: Org) {
      const http = () => request(a.getHttpServer());
      return {
        login: (
          await http().post('/api/v1/auth/login').send({ email: o.pm.email, password: PASSWORD })
        ).status,
        session: (await http().get('/api/v1/auth/me').set('Cookie', o.cookies)).status,
        key: (
          await http()
            .get('/api/v1/ext/v1/projects')
            .set({ Authorization: `Bearer ${o.key}` })
        ).status,
        survey: (await http().get(`/api/v1/public/s/${o.survey}?device=browser-single-1`)).status,
        open: (await http().post(`/api/v1/public/o/${o.openSlug}/start`)).status,
        feedback: (await http().get(`/api/v1/public/f/${o.feedbackSlug}`)).status,
        share: (await http().get(`/api/v1/public/share/${o.share}`)).status,
      };
    }
    const allOpen = {
      login: 200,
      session: 200,
      key: 200,
      survey: 200,
      open: 200,
      feedback: 200,
      share: 200,
    };

    beforeAll(async () => {
      const multi = await start(false);
      made.a = await equip(multi, first, 'a');
      made.b = await equip(multi, second, 'b');
      // And mail still waiting for the dispatcher, for the worker's part.
      for (const [o, tag] of [
        [made.a, 'a'],
        [made.b, 'b'],
      ] as const)
        await wave(o.session, o.tenant.id, o.project, o.qid, `later-${tag}@example.org`);
      for (const a of apps.splice(0)) await a.close();
      mailers.clear();
    });

    it('serves the first and leaves no trace of the second', async () => {
      const a = await start(true, first.slug);
      const A = made.a!;
      const B = made.b!;
      expect(await doors(a, A)).toEqual(allOpen);
      expect(await doors(a, B)).toEqual({
        login: 401,
        session: 401,
        key: 401,
        survey: 404,
        open: 404,
        feedback: 404,
        share: 404,
      });
      const http = () => request(a.getHttpServer());
      // The same answers as for links that never existed: nothing tells the second is there.
      const unknownSurvey = await http().get(`/api/v1/public/s/${'x'.repeat(32)}?device=d-1`);
      const closedSurvey = await http().get(`/api/v1/public/s/${B.survey}?device=d-1`);
      expect(closedSurvey.body).toEqual(unknownSurvey.body);
      const unknownShare = await http().get(`/api/v1/public/share/${'y'.repeat(32)}`);
      expect((await http().get(`/api/v1/public/share/${B.share}`)).body).toEqual(unknownShare.body);
      const unknownOpen = await http().post(`/api/v1/public/o/nosuchslug1/start`);
      expect((await http().post(`/api/v1/public/o/${B.openSlug}/start`)).body).toEqual(
        unknownOpen.body,
      );
      // An account only of the second: a wrong password and a right one answer the same, and
      // no reset e-mail goes out.
      const wrong = await http()
        .post('/api/v1/auth/login')
        .send({ email: B.pm.email, password: 'not the password' });
      expect(wrong.status).toBe(401);
      const right = await http()
        .post('/api/v1/auth/login')
        .send({ email: B.pm.email, password: PASSWORD });
      expect(right.body).toEqual(wrong.body);
      const mailer = mailers.get(a)!;
      mailer.sent.length = 0;
      await http().post('/api/v1/auth/password/forgot').send({ email: B.pm.email });
      await http().post('/api/v1/auth/password/forgot').send({ email: A.pm.email });
      expect(mailer.sent.map((m) => m.to)).toEqual([A.pm.email]);
      // The owner of the second cannot sign in either.
      expect(
        (
          await http()
            .post('/api/v1/auth/login')
            .send({ email: B.ownerUser.email, password: PASSWORD })
        ).status,
      ).toBe(401);
    });

    it('the retention a closed organisation set keeps running: closed never means kept longer', async () => {
      const a = await start(true, first.slug);
      const b = made.b!;
      const caseId = randomUUID();
      await sql`INSERT INTO cases (id, tenant_id, project_id, external_id, sample, status, updated_at)
                VALUES (${caseId}, ${second.id}, ${b.project}, ${'old-b'}, ${JSON.stringify({ tag: 'old-b' })},
                        'finalised', DATEADD(day, -40, SYSDATETIMEOFFSET()))`.execute(owner);
      const before = await sql<{ settings: string }>`
        SELECT settings FROM projects WHERE id = ${b.project}`.execute(owner);
      const settings = {
        ...JSON.parse(before.rows[0]!.settings),
        retention: { anonymiseAfterDays: 30 },
      };
      await sql`UPDATE projects SET settings = ${JSON.stringify(settings)} WHERE id = ${b.project}`.execute(
        owner,
      );
      try {
        // The second stays closed to everything else, yet its retention runs.
        expect(await a.get(Engine).opens(second.id)).toBe(false);
        expect(await a.get(PrivacyService).retentionAll()).toBeGreaterThanOrEqual(1);
        const row = await sql<{ anonymised_at: Date | null }>`
          SELECT anonymised_at FROM cases WHERE id = ${caseId}`.execute(owner);
        expect(row.rows[0]!.anonymised_at).not.toBeNull();
      } finally {
        await sql`UPDATE projects SET settings = ${before.rows[0]!.settings} WHERE id = ${b.project}`.execute(
          owner,
        );
      }
    });

    it('the worker sends only the served organisation’s mail and runs only its jobs', async () => {
      const a = await start(true, first.slug);
      const mailer = mailers.get(a)!;
      mailer.sent.length = 0;
      await a.get(WaveDispatcher).tick();
      await a.get(WaveDispatcher).tick();
      expect(mailer.sent.map((m) => m.to)).toEqual(['later-a@example.org']);
      // The database seen by the jobs: the second is in no list, and cannot be opened.
      const engine = a.get(Engine);
      expect(await engine.allTenantIds()).toEqual([first.id]);
      expect(await engine.tenantsWithMailDue()).not.toContain(second.id);
      expect(await engine.opens(second.id)).toBe(false);
      await expect(engine.sql.withTenant(second.id, async () => 1)).rejects.toMatchObject({
        status: 404,
      });
      // A job queued for the second (before the mode was on) is set aside, not run.
      const jobs = a.get(JobsService);
      const ran: string[] = [];
      jobs.register('test.single', async (d) => {
        ran.push(String(d.tenantId));
      });
      await jobs.run('test.single', { tenantId: second.id });
      await jobs.run('test.single', { tenantId: first.id });
      expect(ran).toEqual([first.id]);
      // The second's mail is still waiting, untouched.
      const waiting = await sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM invitations
        WHERE tenant_id = ${second.id} AND sent_at IS NULL`.execute(owner);
      expect(Number(waiting.rows[0]!.n)).toBe(1);
      // The mail provider's events for the second: nothing is recorded but an opt-out (a
      // complaint), which must hold once it opens again.
      const inv = await sql<{ id: string }>`
        SELECT id FROM invitations WHERE tenant_id = ${second.id} AND email = 'resp-b@example.org'`.execute(
        owner,
      );
      const invitationId = inv.rows[0]!.id.toLowerCase();
      const events = await request(a.getHttpServer())
        .post('/api/v1/webhooks/mail')
        .set('x-webhook-secret', MAIL_SECRET)
        .send({
          events: [
            { invitationId, type: 'delivered' },
            { invitationId, type: 'complaint' },
          ],
        });
      expect(events.status, JSON.stringify(events.body)).toBe(200);
      const after = await sql<{ delivered_at: Date | null; status: string }>`
        SELECT delivered_at, status FROM invitations WHERE id = ${invitationId}`.execute(owner);
      expect(after.rows[0]).toMatchObject({ delivered_at: null, status: 'sent' });
      const sup = await sql<{ reason: string }>`
        SELECT reason FROM suppressions
        WHERE tenant_id = ${second.id} AND email = 'resp-b@example.org'`.execute(owner);
      expect(sup.rows.map((r) => r.reason)).toEqual(['complaint']);
    });

    it('without the mode both organisations work again, the waiting mail included', async () => {
      const a = await start(false);
      expect(await doors(a, made.a!)).toEqual(allOpen);
      expect(await doors(a, made.b!)).toEqual(allOpen);
      const mailer = mailers.get(a)!;
      mailer.sent.length = 0;
      await a.get(WaveDispatcher).tick();
      expect(mailer.sent.map((m) => m.to)).toEqual(['later-b@example.org']);
      const engine = a.get(Engine);
      expect((await engine.allTenantIds()).sort()).toEqual([first.id, second.id].sort());
      expect(await a.get(Tenancy).tenantId()).toBeNull();
    });
  });
});
