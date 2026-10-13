import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
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
