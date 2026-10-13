import { defineConfig, devices } from '@playwright/test';
import { MAIL_DIR } from './e2e/mail.js';

const API_PORT = 3100;
const WEB_PORT = 4173;
const GEO_PORT = 3200;
const adminUrl =
  process.env.E2E_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/wansurvey_e2e';
const redisUrl = process.env.E2E_REDIS_URL ?? 'redis://localhost:6379/1';
const appUrl =
  process.env.E2E_DATABASE_URL ??
  'postgres://wansurvey_app:wansurvey_app@localhost:5432/wansurvey_e2e';

function apiEnv(): Record<string, string> {
  return {
    DATABASE_URL: appUrl,
    DATABASE_ADMIN_URL: adminUrl,
    APP_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    PUBLIC_WEB_URL: `http://localhost:${WEB_PORT}`,
    API_PUBLIC_URL: `http://localhost:${WEB_PORT}`,
    LOGIN_RATE_LIMIT: '1000',
    RATE_LIMIT_PER_IP: '100000',
    GEOCODER: 'nominatim',
    GEOCODER_URL: `http://localhost:${GEO_PORT}`,
    GEOCODER_EMAIL: 'e2e@example.org',
    LOG_LEVEL: 'warn',
    // E-mail goes to files the tests read; the dispatcher runs every second.
    MAILER: 'file',
    MAIL_OUTBOX_DIR: MAIL_DIR,
    DISPATCH_INTERVAL_MS: '1000',
    MAIL_WEBHOOK_SECRET: 'e2e-webhook-secret-0123456789',
    REDIS_URL: redisUrl,
  };
}

/**
 * End-to-end tests against the built API and web app on a fresh `wansurvey_e2e` database.
 * Run `pnpm build` first.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    // The interface defaults to Spanish; these tests use it in English (one test checks the default).
    storageState: './e2e/english-ui.json',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'node e2e/mock-nominatim.mjs',
      url: `http://localhost:${GEO_PORT}/status`,
      reuseExistingServer: false,
      env: { PORT: String(GEO_PORT) },
    },
    // The background worker (jobs: e-mail, stats, exports) with the same settings as the API.
    {
      command: 'node ../api/dist/worker.js',
      reuseExistingServer: false,
      env: apiEnv(),
    },
    {
      command: 'node ../api/dist/main.js',
      // /health needs the database, which global setup creates after the servers start.
      url: `http://localhost:${API_PORT}/docs/openapi.json`,
      reuseExistingServer: false,
      env: { PORT: String(API_PORT), ...apiEnv() },
    },
    {
      command: `pnpm exec vite preview --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
