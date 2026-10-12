import postgres from 'postgres';
import { runMigrations } from '../src/db/migrate.js';

/** Recreates the test database schema from migrations once per run. */
export default async function setup() {
  const admin = process.env.DATABASE_ADMIN_URL!;
  const sql = postgres(admin, { max: 1, onnotice: () => {} });
  await sql.unsafe(
    'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
  );
  await sql.end();
  await runMigrations(admin, process.env.DATABASE_URL!);
}
