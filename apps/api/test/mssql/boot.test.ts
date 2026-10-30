import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '../../src/config.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';

/**
 * The whole application starting on SQL Server (DB_ENGINE=mssql): every module registers, the
 * health check answers from SQL Server, and production refuses the engine while modules are still
 * on PostgreSQL. Runs only where a SQL Server is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;

describe.skipIf(!ADMIN || !APP)('SQL Server: the application boots', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await runMssqlMigrations(ADMIN!, APP!);
    resetConfigCache();
    // Some modules read the configuration when they are imported: after the environment is set.
    const { createApp } = await import('../../src/app.js');
    app = await createApp();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    resetConfigCache();
  });

  it('answers the health check from SQL Server', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: true });
  });

  it('refuses SQL Server in production while modules are still on PostgreSQL', () => {
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      EXPORT_STORAGE: 'blob',
      EXPORT_BLOB_URL: 'https://x.blob.core.windows.net',
    };
    expect(() => loadConfig(env)).toThrow(/not ready for production/);
  });

  it('wants DATABASE_URL to match the engine', () => {
    expect(() => loadConfig({ ...process.env, DB_ENGINE: 'postgres' })).toThrow(/mssql:\/\/ URL/);
    expect(() => loadConfig({ ...process.env, DATABASE_URL: 'postgres://u:p@h/db' })).toThrow(
      /mssql:\/\/ URL/,
    );
  });
});
