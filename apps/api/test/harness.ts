import type { INestApplication } from '@nestjs/common';
import { household } from '@wansurvey/fixtures';
import { compile } from '@wansurvey/logic';
import { Questionnaire, type Role } from '@wansurvey/schema';
import postgres from 'postgres';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import type { AppModuleOptions } from '../src/app.module.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/auth.service.js';
import { encryptField, generateTotpSecret, totp } from '../src/common/crypto.js';
import { MemoryMailer } from '../src/mail/mailer.js';

export const PASSWORD = 'correct horse battery';
let passwordHash: Promise<string> | null = null;

export interface TestApp {
  app: INestApplication;
  mailer: MemoryMailer;
  /** Superuser connection for fixtures (bypasses RLS). */
  admin: postgres.Sql;
  close(): Promise<void>;
}

export async function bootstrap(opts: Omit<AppModuleOptions, 'mailer'> = {}): Promise<TestApp> {
  const mailer = new MemoryMailer();
  const app = await createApp({ ...opts, mailer });
  await app.init();
  const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} });
  return {
    app,
    mailer,
    admin,
    async close() {
      await app.close();
      await admin.end();
    },
  };
}

let counter = 0;
export function unique(prefix: string) {
  counter++;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export async function createTenant(admin: postgres.Sql, slug = unique('t')) {
  const id = uuidv7();
  await admin`insert into tenants (id, name, slug) values (${id}, ${slug}, ${slug})`;
  return { id, slug };
}

export async function createProject(admin: postgres.Sql, tenantId: string, code = unique('P')) {
  const id = uuidv7();
  await admin`insert into projects (id, tenant_id, name, code) values (${id}, ${tenantId}, ${code}, ${code})`;
  return id;
}

export interface TestUser {
  id: string;
  email: string;
  totpSecret: string | null;
}

/**
 * Creates an active account and makes it an active member of `tenantId`. Pass `existing` to add
 * another organisation to an account. Owners/admins get TOTP enrolled, as the policy requires.
 */
export async function createUser(
  admin: postgres.Sql,
  tenantId: string,
  grants: { role: Role; projectId?: string | null }[],
  opts: { email?: string; totp?: boolean; memberStatus?: string; existing?: TestUser } = {},
): Promise<TestUser> {
  let user = opts.existing;
  if (!user) {
    const id = uuidv7();
    const email = opts.email ?? `${unique('u')}@example.org`;
    const needsTotp = opts.totp ?? grants.some((g) => g.role === 'owner' || g.role === 'admin');
    const secret = needsTotp ? generateTotpSecret() : null;
    const enc = secret ? encryptField(secret, process.env.APP_ENCRYPTION_KEY!) : null;
    await admin`
      insert into users (id, email, name, status, password_hash, totp_secret_enc, totp_enabled)
      values (${id}, ${email}, ${email}, 'active', ${await (passwordHash ??= hashPassword(PASSWORD))}, ${enc}, ${needsTotp})`;
    user = { id, email, totpSecret: secret };
  }
  await admin`
    insert into tenant_members (id, tenant_id, user_id, status)
    values (${uuidv7()}, ${tenantId}, ${user.id}, ${opts.memberStatus ?? 'active'})`;
  for (const g of grants) {
    await admin`insert into memberships (id, tenant_id, user_id, role, project_id) values (${uuidv7()}, ${tenantId}, ${user.id}, ${g.role}, ${g.projectId ?? null})`;
  }
  return user;
}

export interface Session {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  tenantId: string;
}

/** Logs in through the API (including the TOTP step when enrolled). */
export async function login(
  app: INestApplication,
  user: TestUser,
  tenant?: string,
): Promise<Session> {
  const agent = request.agent(app.getHttpServer());
  const res = await agent
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: PASSWORD, ...(tenant ? { tenant } : {}) });
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.csrfToken as string;
  if (res.body.mfaState === 'pending') {
    const v = await agent
      .post('/api/v1/auth/2fa/verify')
      .set('x-csrf-token', csrf)
      .send({ code: totp(user.totpSecret!) });
    if (v.status !== 204) throw new Error(`2fa failed: ${v.status} ${JSON.stringify(v.body)}`);
  }
  return { agent, csrf, tenantId: res.body.tenant.id as string };
}

/** Inserts a questionnaire (the household sample by default), optionally published as v1. */
export async function createQuestionnaire(
  admin: postgres.Sql,
  tenantId: string,
  projectId: string,
  opts: { publish?: boolean; definition?: unknown } = {},
): Promise<string> {
  const id = uuidv7();
  const definition = (opts.definition ?? household) as Record<string, unknown>;
  await admin`insert into questionnaires (id, tenant_id, project_id, name, draft)
              values (${id}, ${tenantId}, ${projectId}, ${'Q ' + id.slice(-6)}, ${admin.json(definition as never)})`;
  if (opts.publish) {
    const compiled = compile(definition as never);
    await admin`insert into questionnaire_versions (id, tenant_id, questionnaire_id, version, definition, compiled, hash)
                values (${uuidv7()}, ${tenantId}, ${id}, 1, ${admin.json(Questionnaire.parse(definition) as never)}, ${admin.json(compiled as never)}, ${compiled.hash})`;
  }
  return id;
}
