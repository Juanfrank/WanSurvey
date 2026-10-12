import type { CookieOptions, Response } from 'express';
import type { AppConfig } from '../config.js';

export const SESSION_COOKIE = 'ws_sid';
export const CSRF_COOKIE = 'ws_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function setSessionCookies(res: Response, config: AppConfig, sid: string, csrf: string) {
  const base: CookieOptions = {
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    path: '/',
    maxAge: config.SESSION_ABSOLUTE_HOURS * 3600_000,
  };
  res.cookie(SESSION_COOKIE, sid, { ...base, httpOnly: true });
  // Readable by the web app, which echoes it in the X-CSRF-Token header.
  res.cookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false });
}

export function clearSessionCookies(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}
