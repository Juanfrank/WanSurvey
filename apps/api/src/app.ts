import 'reflect-metadata';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule, type AppModuleOptions } from './app.module.js';
import { loadShedding } from './common/load-shed.js';
import { loadConfig } from './config.js';

export async function createApp(opts: AppModuleOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(opts), {
    bufferLogs: true,
    bodyParser: false,
  });
  // Questionnaire definitions can be large; everything else is small.
  app.useBodyParser('json', { limit: '5mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '100kb' });
  app.useLogger(app.get(Logger));
  const config = loadConfig();
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  // Keep-alive longer than the load balancer's idle timeout (and headers a little longer
  // still), so the balancer never sends a request down a connection the API just closed.
  const server = app.getHttpServer() as Server;
  server.keepAliveTimeout = config.HTTP_KEEPALIVE_MS;
  server.headersTimeout = config.HTTP_KEEPALIVE_MS + 1_000;
  app.use(loadShedding(config.MAX_CONCURRENT_REQUESTS));
  app.disable('x-powered-by');
  app.use(cookieParser());
  const production = config.NODE_ENV === 'production';
  app.use((req: Request, res: Response, next: NextFunction) => {
    // API responses are JSON only; a strict CSP and no sniffing are safe defaults.
    // The Swagger UI page (/docs) needs its own scripts and styles.
    if (!req.path.startsWith('/docs')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // The e-mail open pixel and click links are loaded from mail clients on other origins.
    if (!req.path.startsWith('/api/v1/t/'))
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    // Behind TLS in production (H4); browsers ignore it over plain HTTP anyway.
    if (production)
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('WanSurvey API')
    .setVersion('v1')
    .addCookieAuth('ws_sid')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }, 'csrf')
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, doc), {
    jsonDocumentUrl: 'docs/openapi.json',
  });
  return app;
}
