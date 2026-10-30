import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** The SQL Server tests alone, with no PostgreSQL (CI job `sqlserver`). */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/mssql/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  },
});
