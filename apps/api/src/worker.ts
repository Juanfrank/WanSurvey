import 'reflect-metadata';
import { createServer } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { Engine } from './db/engine.js';
import { initObservability } from './observability.js';

/**
 * The background worker (M1): the API's services without HTTP, running the BullMQ jobs
 * (e-mail dispatch, stats, exports) and their schedules. Needs REDIS_URL.
 */
const config = loadConfig();
if (!config.REDIS_URL) {
  console.error('The worker needs REDIS_URL');
  process.exit(1);
}
initObservability(config);
const app = await NestFactory.createApplicationContext(AppModule.register({ role: 'worker' }), {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
app.enableShutdownHooks();
await app.init();

// Health for hosts that expect every container to answer HTTP (Azure App Service).
if (config.WORKER_HEALTH_PORT) {
  const database = app.get(Engine);
  const server = createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    void database
      .probe()
      .then((ok) =>
        ok
          ? res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
          : res.writeHead(503, { 'content-type': 'application/json' }).end('{"status":"db"}'),
      );
  });
  server.listen(config.WORKER_HEALTH_PORT);
  process.once('SIGTERM', () => server.close());
}
