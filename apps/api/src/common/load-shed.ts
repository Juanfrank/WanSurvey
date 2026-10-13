import type { NextFunction, Request, Response } from 'express';

/**
 * Load shedding: at most `max` requests are handled at once by this process. Beyond that the
 * API answers 503 with Retry-After at once, rather than queueing without limit (and holding
 * memory and database connections) until everything times out. Clients already retry: devices
 * sync again with back-off, the web app shows "busy, try again". Health checks and live
 * dashboards (long-lived event streams) are not counted.
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
    if (inFlight >= max) {
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
