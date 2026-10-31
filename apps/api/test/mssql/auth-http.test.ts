import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../../src/common/crypto.js';
import {
  PASSWORD,
  auditActions,
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
} from './harness.js';

/**
 * Sign-in and the session guard over HTTP, on SQL Server: the services and the stores together
 * Runs only where a SQL Server is given.
 */
describe.skipIf(!configured)('SQL Server: sign-in and sessions over HTTP', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('signs in, answers /me with the person, roles and organisations, and signs out', async () => {
    const project = await createProject(t.owner, tenant.id);
    const user = await createUser(t.owner, tenant.id, [
      { role: 'supervisor', projectId: project },
      { role: 'interviewer' },
    ]);
    const s = await login(t, user, tenant.slug);
    expect(s.tenantId.toLowerCase()).toBe(tenant.id);
    const me = await s.agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: user.id, email: user.email, totpEnabled: false });
    expect(me.body.access.state).toBe('ok');
    expect(me.body.tenants.map((x: { slug: string }) => x.slug)).toEqual([tenant.slug]);
    expect(me.body.memberships.map((m: { role: string }) => m.role).sort()).toEqual([
      'interviewer',
      'supervisor',
    ]);
    expect(me.body.permissions.length).toBeGreaterThan(0);

    // Changing anything needs the CSRF token the session was given.
    expect((await s.agent.post('/api/v1/auth/logout')).status).toBe(403);
    expect((await s.agent.post('/api/v1/auth/logout').set('x-csrf-token', s.csrf)).status).toBe(
      204,
    );
    const after = await s.agent.get('/api/v1/auth/me');
    expect(after.status).toBe(401);
    expect(await auditActions(t.owner, tenant.id)).toEqual(
      expect.arrayContaining(['auth.login', 'auth.logout']),
    );
  });

  it('refuses a wrong password and an unknown e-mail alike, and records the failure', async () => {
    const user = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
    const wrong = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'not the password' });
    const unknown = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.org', password: PASSWORD });
    for (const r of [wrong, unknown]) {
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('INVALID_CREDENTIALS');
    }
    expect(await auditActions(t.owner, tenant.id)).toContain('auth.login_failed');
  });

  it('asks for the second factor, refuses the session until the code, and takes each code once', async () => {
    const owner = await createUser(t.owner, tenant.id, [{ role: 'owner' }]);
    const agent = request.agent(t.app.getHttpServer());
    const res = await agent
      .post('/api/v1/auth/login')
      .send({ email: owner.email, password: PASSWORD, tenant: tenant.slug });
    expect(res.status).toBe(200);
    expect(res.body.mfaState).toBe('pending');
    // Pending: only the pages for entering the code answer.
    const blocked = await agent.get('/api/v1/tenant');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('MFA_REQUIRED');
    const bad = await agent
      .post('/api/v1/auth/2fa/verify')
      .set('x-csrf-token', res.body.csrfToken)
      .send({ code: '000000' });
    expect(bad.status).toBe(401);
    const ok = await agent
      .post('/api/v1/auth/2fa/verify')
      .set('x-csrf-token', res.body.csrfToken)
      .send({ code: totp(owner.totpSecret!) });
    expect(ok.status).toBe(204);
    expect((await agent.get('/api/v1/auth/me')).body.mfaState).toBe('ok');
    // The same code is not accepted a second time.
    const second = request.agent(t.app.getHttpServer());
    const again = await second
      .post('/api/v1/auth/login')
      .send({ email: owner.email, password: PASSWORD, tenant: tenant.slug });
    const reuse = await second
      .post('/api/v1/auth/2fa/verify')
      .set('x-csrf-token', again.body.csrfToken)
      .send({ code: totp(owner.totpSecret!) });
    expect(reuse.status).toBe(401);
    expect(await auditActions(t.owner, tenant.id)).toEqual(
      expect.arrayContaining(['auth.mfa_verified', 'auth.mfa_failed']),
    );
  });

  it('locks the account after repeated failures, and says so only at the code step', async () => {
    const user = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
    const attempt = () =>
      request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'nope nope nope' });
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    const row = await sql<{ locked_until: Date | null }>`
      SELECT locked_until FROM users WHERE id = ${user.id}`.execute(t.owner);
    expect(row.rows[0]!.locked_until).not.toBeNull();
    // Even the right password is refused while it lasts, in the same words as a wrong one.
    const right = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    expect(right.status).toBe(401);
    expect(right.body.code).toBe('INVALID_CREDENTIALS');
    // Once the lock ends the right password works again.
    await sql`UPDATE users SET locked_until = DATEADD(second, -1, SYSDATETIMEOFFSET()) WHERE id = ${user.id}`.execute(
      t.owner,
    );
    expect((await login(t, user, tenant.slug)).tenantId).toBeTruthy();
  });

  it('ends a session left idle, and one whose account or membership was switched off', async () => {
    const idle = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
    const a = await login(t, idle, tenant.slug);
    expect((await a.agent.get('/api/v1/auth/me')).status).toBe(200);
    await sql`UPDATE sessions SET last_seen_at = DATEADD(hour, -2, SYSDATETIMEOFFSET()) WHERE user_id = ${idle.id}`.execute(
      t.owner,
    );
    const gone = await a.agent.get('/api/v1/auth/me');
    expect(gone.status).toBe(401);
    expect(gone.body.code).toBe('SESSION_EXPIRED');

    const off = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
    const b = await login(t, off, tenant.slug);
    await sql`UPDATE tenant_members SET status = 'deactivated' WHERE user_id = ${off.id} AND tenant_id = ${tenant.id}`.execute(
      t.owner,
    );
    expect((await b.agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('moves a person between their organisations with a new session', async () => {
    const other = await createTenant(t.owner);
    const user = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
    await createUser(t.owner, other.id, [{ role: 'supervisor' }], { existing: user });
    const s = await login(t, user, tenant.slug);
    const tenants = await s.agent.get('/api/v1/auth/tenants');
    expect(tenants.body.map((x: { slug: string }) => x.slug).sort()).toEqual(
      [tenant.slug, other.slug].sort(),
    );
    const moved = await s.agent
      .post('/api/v1/auth/switch-tenant')
      .set('x-csrf-token', s.csrf)
      .send({ tenantId: other.id });
    expect(moved.status).toBe(200);
    expect(moved.body.tenant.slug).toBe(other.slug);
    const me = await s.agent.get('/api/v1/auth/me');
    expect(me.body.tenantId).toBe(other.id);
    expect(me.body.memberships.map((m: { role: string }) => m.role)).toEqual(['supervisor']);
    // A person cannot move to an organisation they are not a member of.
    const third = await createTenant(t.owner);
    const refused = await s.agent
      .post('/api/v1/auth/switch-tenant')
      .set('x-csrf-token', moved.body.csrfToken)
      .send({ tenantId: third.id });
    expect(refused.status).toBe(403);
    expect(await auditActions(t.owner, tenant.id)).toContain('auth.tenant_switched');
  });
});
