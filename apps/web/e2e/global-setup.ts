import { hash } from '@node-rs/argon2';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { runMigrations } from '../../api/dist/db/migrate.js';
import { seed } from '../../api/dist/db/seed.js';
import { seedDemoData } from '../../api/dist/db/seed-demo.js';
import { clearMail } from './mail.js';

export const PASSWORD = 'demo-password-123';
export const WAITING_EMAIL = 'waiting@demo.wansurvey.test';

/** Fresh database for every run: migrations, the demo seed and fieldwork, and a member with no role. */
export default async function globalSetup() {
  clearMail();
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
  await seed(adminUrl, PASSWORD);
  // Completed fieldwork for the dashboards, metrics, results and exports.
  await seedDemoData(adminUrl, PASSWORD, 60);

  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const [demo] = await sql`select id from tenants where slug = 'demo'`;
  const id = uuidv7();
  await sql`insert into users (id, email, name, first_name, status, password_hash)
            values (${id}, ${WAITING_EMAIL}, 'Wanda Waiting', 'Wanda', 'active', ${await hash(PASSWORD, { algorithm: 2 })})`;
  await sql`insert into tenant_members (id, tenant_id, user_id, status) values (${uuidv7()}, ${demo!.id}, ${id}, 'active')`;
  await sql.end();
}
