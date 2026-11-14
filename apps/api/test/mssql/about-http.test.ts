import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrap,
  configured,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
} from './harness.js';

describe.skipIf(!configured)(
  'SQL Server: the public facts and the protected technical data',
  () => {
    let t: MssqlTestApp;
    beforeAll(async () => {
      t = await bootstrap();
    });
    afterAll(async () => {
      await t?.close();
    });

    it('answers the facts without a session, and leaves out build, environment and runtime', async () => {
      const res = await request(t.app.getHttpServer()).get('/api/v1/public/about');
      expect(res.status).toBe(200);
      expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(Object.keys(res.body).sort()).toEqual(
        ['author', 'holder', 'organisation', 'privacyContact', 'services', 'version'].sort(),
      );
      for (const key of ['build', 'node', 'environment', 'technical'])
        expect(res.body).not.toHaveProperty(key);
      expect(JSON.stringify(res.body)).not.toContain(process.versions.node);
      expect(JSON.stringify(res.body)).not.toMatch(/DATABASE|SECRET|KEY/);
    });

    it('gives the technical data only to a person with a session', async () => {
      const anonymous = await request(t.app.getHttpServer()).get('/api/v1/system/technical');
      expect(anonymous.status).toBe(401);
      const tenant = await createTenant(t.owner);
      const user = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
      const session = await login(t, user, tenant.slug);
      const res = await session.agent.get('/api/v1/system/technical');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        build: expect.any(String),
        environment: expect.stringMatching(/^(production|development)$/),
        node: process.versions.node,
      });
    });
  },
);
