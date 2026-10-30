import { tmpdir } from 'node:os';
import { join } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** The SQL Server tests alone, with no PostgreSQL (CI job `sqlserver`). */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/mssql/**/*.test.ts'],
    globalSetup: ['./test/mssql/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // The application itself starts on SQL Server in some tests (`DB_ENGINE=mssql`); modules that read
    // the configuration when they are imported need these before anything is.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DB_ENGINE: 'mssql',
      DATABASE_URL: process.env.MSSQL_URL ?? '',
      DATABASE_ADMIN_URL: process.env.MSSQL_ADMIN_URL ?? '',
      APP_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      LOGIN_RATE_LIMIT: '1000',
      RATE_LIMIT_PER_IP: '100000',
      LOGIN_LOCK_AFTER: '3',
      JOB_RETRY_MS: '0',
      EXPORT_DIR: join(tmpdir(), 'wansurvey-test-exports'),
    },
  },
});
