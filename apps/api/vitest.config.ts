import { tmpdir } from 'node:os';
import { join } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * The tests that need no database. Those that do run on SQL Server (`vitest.mssql.config.ts`, CI
 * job `sqlserver`); the files in test/mssql are skipped here.
 */
const env = {
  NODE_ENV: 'test',
  // Some of these tests read the configuration, which asks for a database URL; none connects.
  DATABASE_URL: 'mssql://wansurvey_app:unused@localhost:1433/unused',
  APP_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  LOGIN_RATE_LIMIT: '1000',
  RATE_LIMIT_PER_IP: '100000',
  LOG_LEVEL: 'silent',
  // Failed jobs are tried again at once (tests drain the queue and wait for the last try).
  JOB_RETRY_MS: '0',
  // Export files of the tests, kept out of the repository.
  EXPORT_DIR: join(tmpdir(), 'wansurvey-test-exports'),
};
Object.assign(process.env, env);

export default defineConfig({
  // Nest relies on decorator metadata, which esbuild does not emit.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/mssql/**', '**/node_modules/**'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env,
  },
});
