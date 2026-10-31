import { hash } from '@node-rs/argon2';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { runMigrations } from '../../api/dist/db/migrate.js';
import { openRaw } from '../../api/dist/db/mssql/raw.js';
import { runMssqlMigrations } from '../../api/dist/db/mssql/migrate.js';
import { seed } from '../../api/dist/db/seed.js';
import { seedDemoData } from '../../api/dist/db/seed-demo.js';
import { adminUrl, connectDb, MSSQL } from './db.js';
import { clearMail } from './mail.js';

export const PASSWORD = 'demo-password-123';
export const WAITING_EMAIL = 'waiting@demo.wansurvey.test';

/** Fresh database for every run: migrations, the demo seed and fieldwork, and a member with no role. */
export default async function globalSetup() {
  clearMail();
  if (MSSQL) await createMssqlDatabase();
  else await createPostgresDatabase();
  const db = connectDb();
  try {
    const [org] = await db.all(`select id from tenants where slug = 'demo'`);
    const id = uuidv7();
    await db.run(
      `insert into users (id, email, name, first_name, status, password_hash)
       values (?, ?, 'Wanda Waiting', 'Wanda', 'active', ?)`,
      [id, WAITING_EMAIL, await hash(PASSWORD, { algorithm: 2 })],
    );
    await db.run(
      `insert into tenant_members (id, tenant_id, user_id, status) values (?, ?, ?, 'active')`,
      [uuidv7(), org!.id, id],
    );
  } finally {
    await db.end();
  }
}

/** A fresh PostgreSQL database: migrations, the demo seed and fieldwork. */
async function createPostgresDatabase() {
  const adminUrl =
    process.env.E2E_DATABASE_ADMIN_URL ??
    'postgres://postgres:postgres@localhost:5432/wansurvey_e2e';
  const appUrl =
    process.env.E2E_DATABASE_URL ??
    'postgres://wansurvey_app:wansurvey_app@localhost:5432/wansurvey_e2e';
  const server = new URL(adminUrl);
  const dbName = server.pathname.slice(1);
  server.pathname = '/postgres';
  const root = postgres(server.toString(), { max: 1, onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await root.unsafe(`CREATE DATABASE "${dbName}"`);
  await root.end();

  await runMigrations(adminUrl, appUrl);
  await seedAll(adminUrl);
}

/** A fresh SQL Server database, the same way. */
async function createMssqlDatabase() {
  const appUrl =
    process.env.E2E_MSSQL_URL ??
    'mssql://wansurvey_app:Tr0ub4dor-Stronger%21@localhost:1433/wansurvey_e2e?trustServerCertificate=true';
  const dbName = new URL(adminUrl).pathname.slice(1);
  const server = new URL(adminUrl);
  server.pathname = '/master';
  const root = openRaw(server.toString());
  await root.query(
    `IF DB_ID('${dbName}') IS NOT NULL BEGIN ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${dbName}]; END`,
  );
  await root.query(`CREATE DATABASE [${dbName}]`);
  await root.end();

  await runMssqlMigrations(adminUrl, appUrl);
  await seedAll(adminUrl);
}

async function seedAll(adminUrl: string) {
  // The API's key, so the seed seals personal fields as the API would.
  process.env.APP_ENCRYPTION_KEY ??= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
  await seed(adminUrl, PASSWORD);
  // Completed fieldwork for the dashboards, metrics, results and exports.
  await seedDemoData(adminUrl, PASSWORD, 60);
}
