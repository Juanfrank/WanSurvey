import { sql } from 'kysely';
import { createMssqlDb } from '../../src/db/mssql/connection.js';

/** The test database, made through `master` when the server does not have it yet. */
export default async function setup(): Promise<void> {
  const adminUrl = process.env.MSSQL_ADMIN_URL;
  if (!adminUrl || !process.env.MSSQL_URL) return;
  const url = new URL(adminUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = '/master';
  const master = createMssqlDb<Record<string, never>>(url.toString(), { max: 1 });
  try {
    await sql
      .raw(
        `IF DB_ID(N'${name.replace(/'/g, "''")}') IS NULL CREATE DATABASE [${name.replace(/]/g, ']]')}]`,
      )
      .execute(master);
  } finally {
    await master.destroy();
  }
}
