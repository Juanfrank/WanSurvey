import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { SECURITY_HEADERS } from './security-headers.js';
import { serviceWorker } from './service-worker.js';

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  // The manifest lets `scripts/bundle-budget.mjs` measure what each route loads (H6).
  build: { manifest: true },
  server: {
    port: 5173,
    // Same-origin in development: the API's cookies and CSRF header just work.
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: false },
    },
  },
  // The built app is served with its production headers (H4); the dev server is not, as its
  // hot reloading injects inline scripts.
  preview: {
    port: 4173,
    headers: SECURITY_HEADERS,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
  },
});
