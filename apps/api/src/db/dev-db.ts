import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { createMssqlDb } from './mssql/connection.js';
import { APP_USER, runMssqlMigrations } from './mssql/migrate.js';
import { seed } from './seed.js';

/** The URLs of a development database in the same SQL Server as `adminUrl`. */
export function devUrls(
  adminUrl: string,
  database: string,
  appPassword: string,
): { master: string; admin: string; app: string } {
  const at = (user: string | null, password: string | null, db: string) => {
    const u = new URL(adminUrl);
    if (user !== null) {
      u.username = encodeURIComponent(user);
      u.password = encodeURIComponent(password ?? '');
    }
    u.pathname = `/${db}`;
    return u.toString();
  };
  return {
    master: at(null, null, 'master'),
    admin: at(null, null, database),
    app: at(APP_USER, appPassword, database),
  };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;

const USAGE = `Development database on a SQL Server you already run (not a container):

  pnpm --filter @wansurvey/api db:dev [-- --reset | --drop] [--no-seed]

  (none)     creates the database if it is missing, applies the migrations, loads the demo data
  --reset    drops the database first, so it starts again from nothing
  --drop     drops the database and stops
  --no-seed  leaves the demo data out

Environment:
  DEV_DB_ADMIN_URL      a login with sysadmin rights, e.g. mssql://sa:<password>@localhost:1433/master?trustServerCertificate=true
  DEV_DB_NAME           the database (default wansurvey_dev)
  DEV_DB_APP_PASSWORD   password of the restricted user wansurvey_app (default: a random one, printed)
  SEED_PASSWORD         password of the demo users (default demo-password-123)
`;

export async function devDatabase(
  env: NodeJS.ProcessEnv,
  flags: string[],
  log: (m: string) => void = console.log,
): Promise<void> {
  if (flags.includes('--help')) return log(USAGE);
  const adminUrl = env.DEV_DB_ADMIN_URL;
  if (!adminUrl) throw new Error(`DEV_DB_ADMIN_URL is required.\n\n${USAGE}`);
  const name = env.DEV_DB_NAME ?? 'wansurvey_dev';
  if (!IDENTIFIER.test(name)) throw new Error(`DEV_DB_NAME is not a plain identifier: ${name}`);
  if (/^(master|model|msdb|tempdb)$/i.test(name))
    throw new Error(`DEV_DB_NAME cannot be a system database: ${name}`);
  const generated = !env.DEV_DB_APP_PASSWORD;
  const appPassword = env.DEV_DB_APP_PASSWORD ?? `Ws-${randomBytes(9).toString('base64url')}1!`;
  const urls = devUrls(adminUrl, name, appPassword);

  const master = createMssqlDb<Record<string, never>>(urls.master, { max: 1, requestTimeoutMs: 0 });
  try {
    if (flags.includes('--reset') || flags.includes('--drop')) {
      await sql
        .raw(
          `IF DB_ID(N'${name}') IS NOT NULL BEGIN ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]; END`,
        )
        .execute(master);
      log(`Dropped ${name}`);
      if (flags.includes('--drop')) return;
    }
    await sql.raw(`IF DB_ID(N'${name}') IS NULL CREATE DATABASE [${name}]`).execute(master);
  } finally {
    await master.destroy();
  }
  await runMssqlMigrations(urls.admin, urls.app);
  log(`${name}: migrations applied`);
  if (!flags.includes('--no-seed')) {
    await seed(urls.admin, env.SEED_PASSWORD ?? 'demo-password-123');
  }
  log(`
Put these in apps/api/.env (the application user's password ${generated ? 'was generated: keep it, or the next run changes it' : 'is the one you gave'}):

DATABASE_URL=${urls.app}
DATABASE_ADMIN_URL=${urls.admin}
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  devDatabase(process.env, process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
