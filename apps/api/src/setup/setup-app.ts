import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { compress, isApiPath, serveWeb } from '../common/web.js';
import { VERSION } from '../version.js';
import { SetupModule } from './setup.js';

/**
 * The API without a database: only the installation wizard. Any other API path answers 428
 * SETUP_REQUIRED, which the web app turns into the wizard. Set DATABASE_URL (and the rest) and
 * restart to leave this mode.
 */
export async function startSetup(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(SetupModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.disable('x-powered-by');
  app.use(compress());
  if (env.WEB_DIST) serveWeb(app, env.WEB_DIST, env.NODE_ENV === 'production');
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isApiPath(req.path)) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  // Before the 404: what the wizard does not answer is "install first".
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/') || req.path.startsWith('/api/v1/setup/')) return next();
    res.status(428).json({
      code: 'SETUP_REQUIRED',
      message: 'The installation is not finished: set the database settings (/setup).',
    });
  });
  const port = Number(env.PORT) || 3000;
  await app.listen(port);
  console.log(
    `WanSurvey ${VERSION}: installation wizard on port ${port} (DATABASE_URL is not set)`,
  );
}
