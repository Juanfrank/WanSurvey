import type { Options } from 'pino-http';
import { maskTokens } from './mask.js';

/**
 * How requests are logged: cookies and the CSRF header never reach the log, and the tokens that
 * respondent, unsubscribe, tracking and share links carry in their path are masked.
 */
export function requestLogOptions(level: string): Options {
  return {
    level,
    redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
    serializers: {
      req: (req: { url?: string }) => ({ ...req, url: maskTokens(req.url) }),
    },
  };
}
