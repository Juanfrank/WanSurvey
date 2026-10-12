import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { bootstrap, createProject, createTenant, createUser, type TestApp } from './harness.js';

/** Row-level security, tested directly against the restricted application role. */
describe('tenant isolation (Postgres RLS)', () => {
  let t: TestApp;
  let appSql: postgres.Sql;
  let a: { id: string; slug: string };
  let b: { id: string; slug: string };

  beforeAll(async () => {
    t = await bootstrap();
    appSql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    a = await createTenant(t.admin);
    b = await createTenant(t.admin);
    await createUser(t.admin, a.id, [{ role: 'interviewer' }]);
    await createUser(t.admin, b.id, [{ role: 'interviewer' }]);
    await createProject(t.admin, a.id);
    await createProject(t.admin, b.id);
  });
  afterAll(async () => {
    await appSql.end();
    await t.close();
  });

  const asTenant = <T>(tenantId: string, fn: (sql: postgres.TransactionSql) => Promise<T>) =>
    appSql.begin(async (sql) => {
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(sql);
    }) as Promise<T>;

  it('sees only rows of the current tenant', async () => {
    for (const table of ['tenant_members', 'projects', 'memberships', 'tenants']) {
      const rows = await asTenant(a.id, (sql) => sql`select * from ${sql(table)}`);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.tenant_id ?? r.id).toBe(a.id);
    }
  });

  it('global accounts are visible only to organisations they belong to, or to themselves', async () => {
    const onlyB = await createUser(t.admin, b.id, [{ role: 'interviewer' }]);
    const both = await createUser(t.admin, a.id, [{ role: 'interviewer' }]);
    await createUser(t.admin, b.id, [{ role: 'interviewer' }], { existing: both });
    const idsInA = (await asTenant(a.id, (sql) => sql`select id from users`)).map((r) => r.id);
    expect(idsInA).toContain(both.id);
    expect(idsInA).not.toContain(onlyB.id);
    // With no organisation, a person still sees their own account.
    const self = await appSql.begin(async (sql) => {
      await sql`select set_config('app.user_id', ${onlyB.id}, true)`;
      return sql`select id from users`;
    });
    expect(self.map((r) => r.id)).toEqual([onlyB.id]);
  });

  it('an organisation cannot change a shared account', async () => {
    const both = await createUser(t.admin, a.id, [{ role: 'interviewer' }]);
    await createUser(t.admin, b.id, [{ role: 'interviewer' }], { existing: both });
    const updated = await asTenant(
      a.id,
      (sql) => sql`update users set password_hash = 'x' where id = ${both.id} returning id`,
    );
    expect(updated).toHaveLength(0);
  });

  it('sees nothing without a tenant context', async () => {
    expect(await appSql`select * from users`).toHaveLength(0);
    expect(await appSql`select * from tenants`).toHaveLength(0);
  });

  it('cannot write rows into another tenant', async () => {
    await expect(
      asTenant(
        a.id,
        (sql) =>
          sql`insert into projects (id, tenant_id, name, code) values (${uuidv7()}, ${b.id}, 'x', 'x')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot update or delete rows of another tenant (silently filtered)', async () => {
    const updated = await asTenant(
      a.id,
      (sql) => sql`update projects set name = 'hacked' where tenant_id = ${b.id} returning id`,
    );
    expect(updated).toHaveLength(0);
    const { name } = (await t.admin`select name from projects where tenant_id = ${b.id}`)[0]!;
    expect(name).not.toBe('hacked');
  });

  it('the application role cannot bypass RLS or alter the audit log', async () => {
    const { rolbypassrls, rolsuper } = (
      await t.admin`select rolbypassrls, rolsuper from pg_roles where rolname = 'wansurvey_app'`
    )[0]!;
    expect(rolbypassrls).toBe(false);
    expect(rolsuper).toBe(false);
    await asTenant(
      a.id,
      (sql) =>
        sql`insert into audit_log (id, tenant_id, action) values (${uuidv7()}, ${a.id}, 'test.event')`,
    );
    await expect(asTenant(a.id, (sql) => sql`update audit_log set action = 'x'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(asTenant(a.id, (sql) => sql`delete from audit_log`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('audit log is append-only even for the owner role', async () => {
    await expect(
      t.admin`update audit_log set action = 'x' where tenant_id = ${a.id}`,
    ).rejects.toThrow(/append-only/);
    await expect(t.admin`delete from audit_log where tenant_id = ${a.id}`).rejects.toThrow(
      /append-only/,
    );
  });
});
