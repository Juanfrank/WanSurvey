import type { NextFunction, Request, Response } from 'express';

/**
 * Refuses request bodies sent compressed (`Content-Encoding` other than identity) with 415.
 * No client of ours compresses what it sends, and body-parser before 2.4.0 crashes the process
 * on a compressed body with trailing bytes (GHSA-27r3-jxmh-p828); this stays useful after the
 * upgrade, as compressed bodies are a way round the size limits.
 */
export function plainBodiesOnly() {
  return (req: Request, res: Response, next: NextFunction) => {
    const encoding = req.headers['content-encoding']?.trim().toLowerCase();
    if (encoding && encoding !== 'identity') {
      res.status(415).json({
        statusCode: 415,
        code: 'UNSUPPORTED_ENCODING',
        message: 'Send the body uncompressed',
      });
      return;
    }
    next();
  };
}
