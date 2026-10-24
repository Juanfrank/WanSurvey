/**
 * Microsoft sign-in for the load organisation (made by load-setup.ts), pointed at the mock
 * (load-mock-entra.ts): the interviewers' domain is allowed, and the organisation is the only
 * one with Microsoft sign-in, so the sign-in button needs no e-mail.
 *   DATABASE_ADMIN_URL=… APP_ENCRYPTION_KEY=… tsx scripts/load-sso-setup.ts
 */
import postgres from 'postgres';
import { encryptField } from '../src/common/crypto.js';

const sql = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
const [l] = await sql`select tenant_id from open_links where slug = 'load-open'`;
const tenantId = l!.tenant_id as string;
await sql`update tenant_sso set enabled = false where tenant_id <> ${tenantId}`;
await sql`
  insert into tenant_sso (tenant_id, entra_tenant_id, client_id, client_secret_enc, enabled, allowed_domains)
  values (${tenantId}, '11111111-2222-3333-4444-555555555555', 'load-client',
          ${encryptField('load-secret', process.env.APP_ENCRYPTION_KEY!)}, true, ${['example.org']})
  on conflict (tenant_id) do update set enabled = true, allowed_domains = excluded.allowed_domains,
    entra_tenant_id = excluded.entra_tenant_id, client_id = excluded.client_id,
    client_secret_enc = excluded.client_secret_enc`;
console.log(`Microsoft sign-in on for ${tenantId}`);
await sql.end();
