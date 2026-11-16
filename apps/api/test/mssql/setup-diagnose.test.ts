import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diagnose } from '../../src/setup/diagnose.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { createOwnerDb } from '../../src/db/mssql/owner-schema.js';
import { ADMIN_URL, APP_URL, configured } from './harness.js';

const state = (d: Awaited<ReturnType<typeof diagnose>>) =>
  d.steps.map((s) => `${s.id}:${s.state}${s.reason ? `(${s.reason})` : ''}`);

describe.skipIf(!configured)(
  'SQL Server: where an installation stands, from the application’s user',
  () => {
    const owner = createOwnerDb<Record<string, never>>(ADMIN_URL!, { max: 1 });
    const bare = `diag_bare_${Date.now().toString(36)}`;
    const PW = 'Diag-Pass-8m3!Qx';
    const as = (user: string, password: string) => {
      const u = new URL(APP_URL!);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    beforeAll(async () => {
      // The database as an installation leaves it (the migrations are repeatable).
      await runMssqlMigrations(ADMIN_URL!, APP_URL!);
      // A user that can sign in and has no permission on anything.
      await sql.raw(`CREATE USER [${bare}] WITH PASSWORD = '${PW}'`).execute(owner);
    });
    afterAll(async () => {
      await sql.raw(`DROP USER [${bare}]`).execute(owner);
      await owner.destroy();
    });

    it('is ready with the application’s own user', async () => {
      const d = await diagnose(APP_URL!);
      expect(d.ready).toBe(true);
      expect(state(d)).toEqual(['server:ok', 'login:ok', 'tables:ok']);
    });

    it('says the sign-in is refused (the user is missing or the password is wrong)', async () => {
      const d = await diagnose(as('nobody_here', 'Wrong-Pass-1!'));
      expect(d.ready).toBe(false);
      expect(state(d)).toEqual(['server:ok', 'login:pending(login_failed)', 'tables:blocked']);
    });

    it('says the tables cannot be seen when the user has no permissions', async () => {
      const d = await diagnose(as(bare, PW));
      expect(d.ready).toBe(false);
      expect(state(d)).toEqual(['server:ok', 'login:ok', 'tables:pending(not_visible)']);
    });

    it('says the server cannot be reached', async () => {
      const u = new URL(APP_URL!);
      u.port = '1';
      const d = await diagnose(u.toString());
      expect(d.ready).toBe(false);
      expect(state(d)).toEqual(['server:pending(unreachable)', 'login:blocked', 'tables:blocked']);
    }, 30_000);
  },
);
