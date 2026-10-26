import { existsSync } from 'node:fs';
import { join } from 'node:path';
import compression from 'compression';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** Paths the API answers; everything else is the web app. */
export const isApiPath = (path: string) =>
  path.startsWith('/api/') || path === '/health' || path.startsWith('/docs');

/** Responses streamed as they come: never held back to be compressed. */
const STREAMED = [
  /^\/api\/v1\/projects\/[^/]+\/live$/,
  /^\/api\/v1\/projects\/[^/]+\/exports\/[^/]+\/file$/,
];

/** The web app's policy (what nginx sent when it served the files). */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self'; font-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function webHeaders(res: Response, production: boolean) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(self), camera=(), microphone=(), payment=(), usb=()',
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/** Gzip for answers and files, except the streams (live dashboards, export downloads). */
export function compress(): RequestHandler {
  return compression({
    filter: (req: Request, res: Response) =>
      !STREAMED.some((r) => r.test(req.path)) && compression.filter(req, res),
  });
}

/**
 * The built web app (WEB_DIST), served by the API itself where no web server sits in front
 * (App Service from a zip): hashed assets cached for a year, the app shell and the service
 * worker always revalidated, and any other path answered with the shell (client routes).
 * Nothing is served when the folder is missing (development runs Vite).
 */
export function serveWeb(app: NestExpressApplication, dir: string, production: boolean): boolean {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) return false;
  const files = express.static(dir, {
    index: false,
    fallthrough: true,
    setHeaders(res, path) {
      webHeaders(res, production);
      res.setHeader(
        'Cache-Control',
        /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isApiPath(req.path) || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    files(req, res, () => {
      // A missing asset is a 404, not the app shell (a stale page asking for an old file).
      if (req.path.startsWith('/assets/')) return res.status(404).end();
      webHeaders(res, production);
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(index);
    });
  });
  return true;
}
