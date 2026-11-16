import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classify, ownerFailure } from '../src/setup/diagnose.js';
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
    expect(plan.users).toContain("N' TO [survey_ro]");
    expect(plan.users).toContain('DENY INSERT, UPDATE, DELETE, EXECUTE, ALTER ON SCHEMA::');
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

  it('tells what went wrong with the database from the driver’s error', () => {
    expect(classify({ code: 'ELOGIN', message: 'Login failed for user x' })).toBe('login_failed');
    expect(classify({ originalError: { number: 18456 } })).toBe('login_failed');
    expect(classify({ number: 208, message: 'Invalid object name' })).toBe('not_visible');
    expect(classify({ originalError: { number: 229 } })).toBe('not_visible');
    expect(classify({ code: 'ESOCKET', message: 'Failed to connect to h:1433' })).toBe(
      'unreachable',
    );
    expect(classify({ code: 'ETIMEOUT' })).toBe('unreachable');
    expect(classify(new Error('something else'))).toBe('other');
  });

  it('says where the installation stands when the owner’s migrations fail', () => {
    const steps = (e: unknown) =>
      ownerFailure(e).steps.map((s) => `${s.id}:${s.state}${s.reason ? `(${s.reason})` : ''}`);
    expect(steps({ code: 'ESOCKET', message: 'Failed to connect' })).toEqual([
      'server:pending(unreachable)',
      'migrations:blocked',
      'login:blocked',
      'tables:blocked',
    ]);
    expect(steps({ code: 'ELOGIN', message: 'Login failed for user sa' })).toEqual([
      'server:ok',
      'migrations:pending(owner_login_failed)',
      'login:blocked',
      'tables:blocked',
    ]);
    expect(steps(new Error('Incorrect syntax near x'))[1]).toBe(
      'migrations:pending(migration_failed)',
    );
    expect(ownerFailure(new Error('x')).ready).toBe(false);
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
      const status = (await request(http).get('/api/v1/setup/status')).body;
      expect(status.setup).toBe(true);
      expect(status.mode).toBe('missing');
      expect(status.diagnosis).toBeNull();
      expect((await request(http).post('/api/v1/setup/check')).body.diagnosis).toBeNull();
      expect((await request(http).get('/health')).body.status).toBe('setup');
      const ok = await request(http).post('/api/v1/setup/scripts').send(body);
      expect(ok.status).toBe(201);
      expect(ok.body.tables).toContain('survey.__migrations');
      expect((await request(http).post('/api/v1/setup/scripts').send({})).status).toBe(400);
    });
  });
});
