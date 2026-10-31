import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Files in `public/` the app shell needs offline. */
const PUBLIC = [
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable.png',
  '/theme.js',
];

/**
 * The service worker (D3), written at build time with the list of built files so the whole
 * app shell is cached on install:
 * - page loads: network first, falling back to the cached `index.html` with no connection;
 * - built assets (`/assets/*`, hashed): cache first;
 * - the API is never cached: interview data lives in IndexedDB.
 */
export function serviceWorker(): Plugin {
  return {
    name: 'wansurvey-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => !f.endsWith('.map'))
        .map((f) => `/${f}`);
      const shell = ['/', ...files, ...PUBLIC];
      const version = createHash('sha256').update(shell.join('\n')).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: source(shell, version) });
    },
  };
}

function source(shell: string[], version: string) {
  return `// Generated at build time (apps/web/service-worker.ts).
const CACHE = 'wansurvey-${version}';
const SHELL = ${JSON.stringify(shell)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('wansurvey-') && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match('/index.html', { ignoreVary: true }).then((hit) => hit || caches.match('/', { ignoreVary: true })),
      ),
    );
    return;
  }
  event.respondWith(
    // The files are cached by their hashed address and the server answers them with
    // \`Vary: Origin\`; recent browsers send an Origin header on module scripts that the cached
    // copy was not stored with, so the Vary header must not decide the match.
    caches.match(req, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && url.pathname.startsWith('/assets/')) {
            const copy = res.clone();
            void caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
`;
}
