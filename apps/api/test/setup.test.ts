import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPlan, setupRequired, SetupModule, SetupRequest } from '../src/setup/setup.js';

const body = {
  server: 'sql.example.org',
  database: 'mi_base',
  schema: 'survey',
  appUser: 'survey_rw',
  readonlyUser: 'survey_ro',
};

describe('the installation wizard', () => {
  it('is on only while DATABASE_URL is missing', () => {
    expect(setupRequired({})).toBe(true);
    expect(setupRequired({ DATABASE_URL: '  ' })).toBe(true);
    expect(setupRequired({ DATABASE_URL: 'mssql://u:p@h/d' })).toBe(false);
  });

  it('answers two scripts and the settings, with no password in any of them', () => {
    const plan = setupPlan(SetupRequest.parse(body));
    expect(plan.tables).toContain('CREATE SCHEMA [survey]');
    expect(plan.tables).not.toContain('CREATE USER');
    expect(plan.users).toContain("CREATE USER [survey_rw] WITH PASSWORD = '$(AppPassword)'");
    expect(plan.users).toContain('GRANT SELECT ON SCHEMA::bi TO [survey_ro]');
    expect(plan.passwordVariables).toEqual(['AppPassword', 'ReaderPassword']);
    const urls = plan.settings.filter((s) => s.secret).map((s) => s.value);
    expect(urls).toHaveLength(3);
    for (const u of urls) expect(u).toContain(':<password>@sql.example.org:1433/mi_base');
    expect(plan.settings.find((s) => s.name === 'DATABASE_SCHEMA')!.value).toBe('survey');
  });

  it('checks the users instead of making them when the DBA makes them', () => {
    const plan = setupPlan(SetupRequest.parse({ ...body, usersByDba: true }));
    expect(plan.users).not.toContain('CREATE USER');
    expect(plan.passwordVariables).toEqual([]);
    expect(plan.settings.some((s) => s.name === 'DATABASE_MANAGE_USERS')).toBe(true);
  });

  it('refuses names that are not safe, and a reader that is the application user', () => {
    expect(SetupRequest.safeParse({ ...body, schema: 'a]; DROP' }).success).toBe(false);
    expect(SetupRequest.safeParse({ ...body, server: 'x y' }).success).toBe(false);
    expect(() => setupPlan(SetupRequest.parse({ ...body, readonlyUser: 'SURVEY_RW' }))).toThrow();
  });

  describe('over HTTP', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await NestFactory.create(SetupModule, { logger: false });
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();
    });
    afterAll(() => app.close());

    it('serves the status and the scripts, and rejects a bad request', async () => {
      const http = app.getHttpServer();
      expect((await request(http).get('/api/v1/setup/status')).body.setup).toBe(true);
      expect((await request(http).get('/health')).body.status).toBe('setup');
      const ok = await request(http).post('/api/v1/setup/scripts').send(body);
      expect(ok.status).toBe(201);
      expect(ok.body.tables).toContain('survey.__migrations');
      expect((await request(http).post('/api/v1/setup/scripts').send({})).status).toBe(400);
    });
  });
});
