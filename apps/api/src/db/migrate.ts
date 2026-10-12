import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export const APP_ROLE = 'wansurvey_app';
const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Ensures the restricted application role exists (password taken from DATABASE_URL), then applies
 * migrations as the owner. The app role never owns tables, so RLS always applies to it.
 */
export async function runMigrations(adminUrl: string, appUrl: string): Promise<void> {
  const app = new URL(appUrl);
  const role = decodeURIComponent(app.username);
  const password = decodeURIComponent(app.password);
  if (role !== APP_ROLE) throw new Error(`DATABASE_URL must connect as ${APP_ROLE} (got ${role})`);

  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<
      { exists: boolean }[]
    >`select exists(select 1 from pg_roles where rolname = ${role})`;
    const exists = row!.exists;
    const opts = 'LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
    const template = `${exists ? 'ALTER' : 'CREATE'} ROLE %I ${opts}`;
    const [fmt] = await sql<
      { stmt: string }[]
    >`select format(${template}::text, ${role}::text, ${password}::text) as stmt`;
    await sql.unsafe(fmt!.stmt);
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const admin = process.env.DATABASE_ADMIN_URL;
  const app = process.env.DATABASE_URL;
  if (!admin || !app) {
    console.error('DATABASE_ADMIN_URL and DATABASE_URL are required');
    process.exit(1);
  }
  runMigrations(admin, app)
    .then(() => console.log('Migrations applied'))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
