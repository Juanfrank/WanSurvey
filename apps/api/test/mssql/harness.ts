import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Role } from '@wansurvey/schema';
import { sql } from 'kysely';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { AppModuleOptions } from '../../src/app.module.js';
import { hashPassword } from '../../src/auth/auth.service.js';
import { encryptField, generateTotpSecret, totp } from '../../src/common/crypto.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { MemoryMailer } from '../../src/mail/mailer.js';

/**
 * The integration-test harness on SQL Server: the whole application started on it
 * (vitest.mssql.config.ts), fixtures written as the
 * database's owner, and sign-in through the API. The HTTP tests written with it check the stores
 * and the services together.
 */
export const PASSWORD = 'correct horse battery';
export const ADMIN_URL = process.env.MSSQL_ADMIN_URL;
export const APP_URL = process.env.MSSQL_URL;
export const configured = !!ADMIN_URL && !!APP_URL;

type Owner = ReturnType<typeof createMssqlDb<Record<string, never>>>;
let passwordHash: Promise<string> | null = null;
let counter = 0;

export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++counter}`;

export interface MssqlTestApp {
  app: INestApplication;
  mailer: MemoryMailer;
  /** The database's owner (outside the security policies), for fixtures and checks. */
  owner: Owner;
  close(): Promise<void>;
}

export async function bootstrap(
  opts: Omit<AppModuleOptions, 'mailer'> = {},
): Promise<MssqlTestApp> {
  await runMssqlMigrations(ADMIN_URL!, APP_URL!);
  const mailer = new MemoryMailer();
  const app = await createApp({ ...opts, mailer });
  await app.init();
  const owner = createMssqlDb<Record<string, never>>(ADMIN_URL!, { max: 2 });
  return {
    app,
    mailer,
    owner,
    async close() {
      await app.close();
      await owner.destroy();
    },
  };
}

export async function createTenant(owner: Owner, slug = unique('t')) {
  const id = randomUUID();
  await sql`INSERT INTO tenants (id, name, slug) VALUES (${id}, ${slug}, ${slug})`.execute(owner);
  return { id, slug };
}

export async function createProject(owner: Owner, tenantId: string, code = unique('P')) {
  const id = randomUUID();
  await sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${id}, ${tenantId}, ${code}, ${code})`.execute(
    owner,
  );
  return id;
}

export interface TestUser {
  id: string;
  email: string;
  totpSecret: string | null;
}

/**
 * Creates an active account and makes it an active member of `tenantId`; pass `existing` to add
 * another organisation to an account. Owners and admins get TOTP, as the policy requires.
 */
export async function createUser(
  owner: Owner,
  tenantId: string,
  grants: { role: Role; projectId?: string | null }[],
  opts: { email?: string; totp?: boolean; memberStatus?: string; existing?: TestUser } = {},
): Promise<TestUser> {
  let user = opts.existing;
  if (!user) {
    const id = randomUUID();
    const email = opts.email ?? `${unique('u')}@example.org`;
    const needsTotp = opts.totp ?? grants.some((g) => g.role === 'owner' || g.role === 'admin');
    const secret = needsTotp ? generateTotpSecret() : null;
    const enc = secret ? encryptField(secret, process.env.APP_ENCRYPTION_KEY!) : null;
    const hash = await (passwordHash ??= hashPassword(PASSWORD));
    await sql`INSERT INTO users (id, email, name, status, password_hash, totp_secret_enc, totp_enabled)
              VALUES (${id}, ${email}, ${email}, 'active', ${hash}, ${enc}, ${needsTotp ? 1 : 0})`.execute(
      owner,
    );
    user = { id, email, totpSecret: secret };
  }
  await sql`INSERT INTO tenant_members (id, tenant_id, user_id, status)
            VALUES (${randomUUID()}, ${tenantId}, ${user.id}, ${opts.memberStatus ?? 'active'})`.execute(
    owner,
  );
  for (const g of grants)
    await sql`INSERT INTO memberships (id, tenant_id, user_id, role, project_id)
              VALUES (${randomUUID()}, ${tenantId}, ${user.id}, ${g.role}, ${g.projectId ?? null})`.execute(
      owner,
    );
  return user;
}

export interface Session {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  tenantId: string;
}

/** Signs in through the API, including the second-factor step when the account has one. */
export async function login(t: MssqlTestApp, user: TestUser, tenant?: string): Promise<Session> {
  const agent = request.agent(t.app.getHttpServer());
  const res = await agent
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: PASSWORD, ...(tenant ? { tenant } : {}) });
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.csrfToken as string;
  if (res.body.mfaState === 'pending') {
    // Each code works once, and tests sign the same person in many times within 30 seconds.
    await sql`UPDATE users SET totp_last_step = NULL WHERE id = ${user.id}`.execute(t.owner);
    const v = await agent
      .post('/api/v1/auth/2fa/verify')
      .set('x-csrf-token', csrf)
      .send({ code: totp(user.totpSecret!) });
    if (v.status !== 204) throw new Error(`2fa failed: ${v.status} ${JSON.stringify(v.body)}`);
  }
  return { agent, csrf, tenantId: res.body.tenant.id as string };
}

/** Audit entries of an organisation, oldest first. */
export async function auditActions(owner: Owner, tenantId: string): Promise<string[]> {
  const res = await sql<{ action: string }>`
    SELECT action FROM audit_log WHERE tenant_id = ${tenantId} ORDER BY at, id`.execute(owner);
  return res.rows.map((r) => r.action);
}
