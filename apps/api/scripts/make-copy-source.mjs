#!/usr/bin/env node
/* global process, console, URL */
// A PostgreSQL database to rehearse the copy on: migrated, with the demo organisation and its
// fieldwork. Run from apps/api after `pnpm build`.
//   PG_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres  DB=wansurvey_source
//   DEMO_INTERVIEWS=2000  node scripts/make-copy-source.mjs
import postgres from 'postgres';
import { runMigrations } from '../dist/db/migrate.js';
import { seed } from '../dist/db/seed.js';
import { seedDemoData } from '../dist/db/seed-demo.js';

const admin = process.env.PG_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const name = process.env.DB ?? 'wansurvey_source';
if (!/^[a-z0-9_]+$/.test(name)) throw new Error('DB must be a plain name');
process.env.APP_ENCRYPTION_KEY ??= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const root = postgres(admin, { max: 1, onnotice: () => {} });
await root.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await root.unsafe(`CREATE DATABASE "${name}"`);
await root.end();
const base = new URL(admin);
base.pathname = `/${name}`;
const app = new URL(base);
app.username = 'wansurvey_app';
app.password = 'wansurvey_app';
await runMigrations(base.toString(), app.toString());
await seed(base.toString(), 'demo-password-123');
await seedDemoData(
  base.toString(),
  'demo-password-123',
  Number(process.env.DEMO_INTERVIEWS ?? 2000),
);
console.log(`Source database ${name} ready.`);
