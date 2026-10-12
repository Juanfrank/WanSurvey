import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const env = {
  NODE_ENV: 'test',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    'postgres://wansurvey_app:wansurvey_app@localhost:5432/wansurvey_test',
  DATABASE_ADMIN_URL:
    process.env.TEST_DATABASE_ADMIN_URL ??
    'postgres://postgres:postgres@localhost:5432/wansurvey_test',
  APP_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  LOGIN_RATE_LIMIT: '1000',
  LOG_LEVEL: 'silent',
};
// globalSetup runs in the main process, so it needs the same variables.
Object.assign(process.env, env);

export default defineConfig({
  // Nest relies on decorator metadata, which esbuild does not emit.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env,
  },
});
