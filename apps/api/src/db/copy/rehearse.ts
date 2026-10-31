import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { createMssqlDb } from '../mssql/connection.js';
import { runMssqlMigrations } from '../mssql/migrate.js';
import { copyData } from './copy.js';
import { verifyCopy } from './verify.js';

/**
 * A rehearsal of the data copy on throwaway databases: drops and creates the target database,
 * applies the T-SQL migrations, copies from the source and verifies. For tests and for trying the
 * copy on a snapshot before the real one; it never runs against a database that holds anything
 * worth keeping, so it only acts on a name that says so (`…_copy`, `…_rehearsal`).
 *
 *   SOURCE_DATABASE_URL        postgres://…  the database to copy from (read only)
 *   TARGET_DATABASE_ADMIN_URL  mssql://…     an owner, on a database called *_copy or *_rehearsal
 *   TARGET_DATABASE_URL        mssql://wansurvey_app:…  the application user, for the migrations
 */
export async function rehearse(log: (m: string) => void = console.log): Promise<boolean> {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_ADMIN_URL;
  const appUrl = process.env.TARGET_DATABASE_URL;
  if (!sourceUrl || !targetUrl || !appUrl)
    throw new Error(
      'SOURCE_DATABASE_URL, TARGET_DATABASE_ADMIN_URL and TARGET_DATABASE_URL are required',
    );
  const name = decodeURIComponent(new URL(targetUrl).pathname.slice(1));
  if (!/_(copy|rehearsal)$/.test(name))
    throw new Error(
      `Refusing to recreate "${name}": the rehearsal only acts on a database whose name ends in _copy or _rehearsal`,
    );
  const master = new URL(targetUrl);
  master.pathname = '/master';
  const root = createMssqlDb<Record<string, never>>(master.toString(), {
    max: 1,
    requestTimeoutMs: 0,
  });
  try {
    await sql
      .raw(
        `IF DB_ID(N'${name}') IS NOT NULL BEGIN ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]; END; CREATE DATABASE [${name}]`,
      )
      .execute(root);
  } finally {
    await root.destroy();
  }
  log(`Database ${name} created.`);
  await runMssqlMigrations(targetUrl, appUrl);
  log('T-SQL migrations applied.');
  const c = await copyData({ sourceUrl, targetUrl, log });
  log(`Copied ${c.total} rows in ${c.tables.length} tables, ${c.seconds.toFixed(1)} s.`);
  const v = await verifyCopy({ sourceUrl, targetUrl, log: () => undefined });
  for (const t of v.tables.filter((x) => x.mismatches.length)) {
    log(`PROBLEM in ${t.table}:`);
    for (const m of t.mismatches) log(`  ${m}`);
  }
  log(v.ok ? `Verified: ${v.tables.length} tables match.` : 'The copy differs from the source.');
  return v.ok;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  rehearse().then(
    (ok) => process.exit(ok ? 0 : 1),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
