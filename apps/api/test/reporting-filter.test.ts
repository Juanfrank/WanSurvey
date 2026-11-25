import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Controller,
  Get,
  type INestApplication,
  Module,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { telemetry } from '../src/observability/app-insights.js';
import { ReportingFilter } from '../src/observability/reporting-filter.js';

@Controller()
class BoomController {
  @Get('boom/:id')
  boom(): never {
    throw new Error('Could not write to ana@x.org (phone 8095550123)');
  }
  @Get('missing')
  missing(): never {
    throw new NotFoundException('No such case');
  }
  @Get('unavailable')
  unavailable(): never {
    throw new ServiceUnavailableException('Database down');
  }
}

@Module({ controllers: [BoomController] })
class BoomModule {}

interface Sent {
  data: {
    baseType: string;
    baseData: {
      exceptions?: { message: string }[];
      properties?: Record<string, string>;
      name?: string;
    };
  };
}

describe('the server-side failures go to the error reporting', () => {
  let app: INestApplication;
  let ingestion: Server;
  const sent: Sent[] = [];

  beforeAll(async () => {
    ingestion = createServer((req, res) => {
      let text = '';
      req.on('data', (c: Buffer) => (text += c.toString()));
      req.on('end', () => {
        sent.push(...(JSON.parse(text) as Sent[]));
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((ok) => ingestion.listen(0, '127.0.0.1', ok));
    const port = (ingestion.address() as AddressInfo).port;
    telemetry.init({
      connectionString: `InstrumentationKey=01234567-89ab-4def-8123-456789abcdef;IngestionEndpoint=http://127.0.0.1:${port}/`,
      role: 'wansurvey-api',
      version: 'test',
      intervalMs: 0,
    });
    app = await NestFactory.create(BoomModule, { logger: false });
    app.useGlobalFilters(new ReportingFilter(app.get(HttpAdapterHost).httpAdapter));
    await app.init();
  });
  afterAll(async () => {
    telemetry.stop();
    await app.close();
    ingestion.close();
  });

  it('reports an error nobody handled and a 5xx, cleaned, and not a 4xx; the answers do not change', async () => {
    const http = app.getHttpServer();
    expect((await request(http).get('/boom/42?phone=8095550123')).status).toBe(500);
    expect((await request(http).get('/missing')).status).toBe(404);
    expect((await request(http).get('/unavailable')).status).toBe(503);
    await telemetry.flush();
    const messages = sent.map((s) => s.data.baseData.exceptions?.[0]?.message);
    expect(messages).toEqual(['Could not write to [email] (phone [number])', 'Database down']);
    const props = sent.map((s) => s.data.baseData.properties);
    // The route pattern, not the address: no id, no query string.
    expect(props[0]).toEqual({ method: 'GET', route: '/boom/:id', status: '500' });
    expect(props[1]).toMatchObject({ route: '/unavailable', status: '503' });
    expect(JSON.stringify(sent)).not.toMatch(/ana@x\.org|8095550123|phone=/);
  });
});
