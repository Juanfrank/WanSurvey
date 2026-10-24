import type { NextFunction, Request, Response } from 'express';

/**
 * Load shedding: at most `max` requests are handled at once by this process. Beyond that the
 * API answers 503 with Retry-After at once, rather than queueing without limit (and holding
 * memory and database connections) until everything times out. Clients already retry: devices
 * sync again with back-off, the web app shows "busy, try again". Health checks and live
 * dashboards (long-lived event streams) are not counted.
 *
 * By priority: when the process is full, new work is turned away first, and the steps of
 * interviews already under way last. A 503 halfway through an interview wastes the work its
 * earlier steps cost; in the load tests (load/results.md) this kept 51 completes a second
 * under overload instead of 37, and no started interview was refused.
 * - new (opening an open link): up to 60 % of `max`;
 * - under way (a respondent's survey, a device's sync or submission): up to twice `max`;
 * - everything else: up to `max`.
 */
export function loadShedding(max: number, retryAfterSeconds = 2) {
  let inFlight = 0;
  const middleware = (req: Request, res: Response, next: NextFunction) => {
    if (
      max <= 0 ||
      req.path === '/health' ||
      (req.headers.accept ?? '').includes('text/event-stream')
    )
      return next();
    if (inFlight >= limitFor(priority(req), max)) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(503).json({
        statusCode: 503,
        code: 'BUSY',
        message: 'The server is busy; please try again in a moment',
      });
      return;
    }
    inFlight++;
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      inFlight--;
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
  return Object.assign(middleware, { inFlight: () => inFlight });
}

type Priority = 'new' | 'under_way' | 'normal';

/** How much a request matters when the process is full (see loadShedding). */
export function priority(req: Pick<Request, 'method' | 'path'>): Priority {
  const { method, path } = req;
  if (method === 'POST' && path.startsWith('/api/v1/public/o/')) return 'new';
  if (path.startsWith('/api/v1/public/s/')) return 'under_way';
  if (
    method === 'POST' &&
    (path === '/api/v1/interviews/sync' || /^\/api\/v1\/interviews\/[^/]+\/submit$/.test(path))
  )
    return 'under_way';
  return 'normal';
}

const limitFor = (p: Priority, max: number) =>
  p === 'new' ? Math.max(1, Math.floor(max * 0.6)) : p === 'under_way' ? max * 2 : max;
