import { ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadShedding } from '../src/common/load-shed.js';
import { loadConfig } from '../src/config.js';
import { Database, pgCode } from '../src/db/database.js';
import { bootstrap, createProject, createTenant, type TestApp } from './harness.js';

describe('database under concurrent use', () => {
  let t: TestApp;
  let db: Database;
  let tenant: { id: string };

  beforeAll(async () => {
    t = await bootstrap();
    db = t.app.get(Database);
    tenant = await createTenant(t.admin);
  });
  afterAll(() => t.close());

  it('runs a transaction again after a serialization failure or a deadlock', async () => {
    for (const code of ['40001', '40P01']) {
      let runs = 0;
      const out = await db.withTenant(tenant.id, async () => {
        runs++;
        if (runs === 1) throw Object.assign(new Error('conflict'), { code });
        return 'done';
      });
      expect(out).toBe('done');
      expect(runs).toBe(2);
    }
    // Not forever: the third failure is reported.
    let runs = 0;
    await expect(
      db.withTenant(tenant.id, async () => {
        runs++;
        throw Object.assign(new Error('conflict'), { code: '40001' });
      }),
    ).rejects.toThrow('conflict');
    expect(runs).toBe(3);
  });

  it('pins time limits and the tenant for the transaction only', async () => {
    const config = loadConfig();
    const [inside] = await db.withTenant(tenant.id, (tx) =>
      tx.execute<{ st: string; lt: string; it: string; tenant: string }>(
        sql`select current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt,
                   current_setting('idle_in_transaction_session_timeout') as it,
                   current_setting('app.tenant_id') as tenant`,
      ),
    );
    expect(inside).toMatchObject({ tenant: tenant.id });
    const ms = (v: string) =>
      v.endsWith('ms') ? Number(v.slice(0, -2)) : Number(v.slice(0, -1)) * 1000;
    expect(ms(inside!.st)).toBe(config.DB_STATEMENT_TIMEOUT_MS);
    expect(ms(inside!.lt)).toBe(config.DB_LOCK_TIMEOUT_MS);
    // Outside the transaction, the connection is back to the defaults (pooler-safe).
    const [after] = await db.client<{ tenant: string | null }[]>`
      select nullif(current_setting('app.tenant_id', true), '') as tenant`;
    expect(after!.tenant).toBeNull();
  });

  it('answers 503 BUSY instead of waiting on a lock held too long', async () => {
    const project = await createProject(t.admin, tenant.id);
    // Someone else holds the row (a long transaction elsewhere).
    let release!: () => void;
    const held = new Promise<void>((ok) => (release = ok));
    const holder = t.admin.begin(async (x) => {
      await x`select id from projects where id = ${project} for update`;
      await held;
    });
    await new Promise((ok) => setTimeout(ok, 100));
    const started = Date.now();
    const err = await db
      .withTenant(tenant.id, async (tx) => {
        await tx.execute(sql`set local lock_timeout = '300ms'`);
        await tx.execute(sql`select id from projects where id = ${project} for update`);
      })
      .catch((e: unknown) => e);
    release();
    await holder;
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'BUSY' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('finds the Postgres code of a wrapped driver error', () => {
    expect(pgCode({ cause: { code: '40P01' } })).toBe('40P01');
    expect(pgCode(new Error('x'))).toBeUndefined();
  });

  it('computes one live dashboard snapshot for every viewer of a project', async () => {
    const { LiveService } = await import('../src/dashboard/live.service.js');
    const live = t.app.get(LiveService) as unknown as {
      shared(tenantId: string, projectId: string): Promise<unknown>;
    };
    const project = await createProject(t.admin, tenant.id);
    let queries = 0;
    const original = db.withTenant.bind(db);
    db.withTenant = ((...args: Parameters<Database['withTenant']>) => {
      queries++;
      return original(...args);
    }) as Database['withTenant'];
    try {
      const [a, b, c] = await Promise.all([
        live.shared(tenant.id, project),
        live.shared(tenant.id, project),
        live.shared(tenant.id, project),
      ]);
      expect(queries).toBe(1);
      expect(a).toBe(b);
      expect(b).toBe(c);
      // Within a second it is served again without a query.
      await live.shared(tenant.id, project);
      expect(queries).toBe(1);
    } finally {
      db.withTenant = original;
    }
  });

  it('keeps connections open longer than the load balancer', () => {
    const server = t.app.getHttpServer() as import('node:http').Server;
    const config = loadConfig();
    expect(server.keepAliveTimeout).toBe(config.HTTP_KEEPALIVE_MS);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });
});

describe('load shedding', () => {
  type Listener = () => void;
  const fakeRes = () => {
    const on: Record<string, Listener[]> = {};
    const res = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      body: undefined as unknown,
      setHeader(k: string, v: string) {
        res.headers[k] = v;
      },
      status(c: number) {
        res.statusCode = c;
        return res;
      },
      json(b: unknown) {
        res.body = b;
        return res;
      },
      on(ev: string, f: Listener) {
        (on[ev] ??= []).push(f);
      },
      emit(ev: string) {
        for (const f of on[ev] ?? []) f();
      },
    };
    return res;
  };
  const req = (path = '/api/v1/x', accept = 'application/json') =>
    ({ path, headers: { accept } }) as never;

  it('answers 503 with Retry-After beyond the limit, and frees the slot when a request ends', () => {
    const shed = loadShedding(2);
    const passed: number[] = [];
    const first = fakeRes();
    const second = fakeRes();
    shed(req(), first as never, () => passed.push(1));
    shed(req(), second as never, () => passed.push(2));
    const third = fakeRes();
    shed(req(), third as never, () => passed.push(3));
    expect(passed).toEqual([1, 2]);
    expect(third.statusCode).toBe(503);
    expect(third.headers['Retry-After']).toBe('2');
    expect(third.body).toMatchObject({ code: 'BUSY' });
    // finish and close both fire for one request: counted once.
    first.emit('finish');
    first.emit('close');
    expect(shed.inFlight()).toBe(1);
    shed(req(), fakeRes() as never, () => passed.push(4));
    expect(passed).toEqual([1, 2, 4]);
  });

  it('turns new work away first and lets interviews under way go on longest', () => {
    const shed = loadShedding(10);
    const at = (method: string, path: string) => ({ method, path, headers: {} }) as never;
    let n = 0;
    // Fill to 6 with ordinary requests: an open link is now refused, the rest go on.
    for (let i = 0; i < 6; i++) shed(at('GET', '/api/v1/projects'), fakeRes() as never, () => n++);
    const open = fakeRes();
    shed(at('POST', '/api/v1/public/o/slug/start'), open as never, () => n++);
    expect(open.statusCode).toBe(503);
    // At 10 an ordinary request is refused; a respondent's sync or a device's submission is not.
    for (let i = 0; i < 4; i++) shed(at('GET', '/api/v1/projects'), fakeRes() as never, () => n++);
    const staff = fakeRes();
    shed(at('GET', '/api/v1/projects'), staff as never, () => n++);
    expect(staff.statusCode).toBe(503);
    for (const [m, p] of [
      ['POST', '/api/v1/public/s/token-abc/sync'],
      ['POST', '/api/v1/interviews/sync'],
      ['POST', '/api/v1/interviews/0190-x/submit'],
    ])
      shed(at(m!, p!), fakeRes() as never, () => n++);
    expect(n).toBe(13);
    // Up to twice the limit, then those too are refused.
    for (let i = 0; i < 7; i++)
      shed(at('GET', '/api/v1/public/s/t'), fakeRes() as never, () => n++);
    const late = fakeRes();
    shed(at('GET', '/api/v1/public/s/t'), late as never, () => n++);
    expect(late.statusCode).toBe(503);
    expect(shed.inFlight()).toBe(20);
  });

  it('never counts health checks or live event streams', () => {
    const shed = loadShedding(1);
    shed(req(), fakeRes() as never, () => {});
    let ok = 0;
    shed(req('/health'), fakeRes() as never, () => ok++);
    shed(req('/api/v1/x', 'text/event-stream'), fakeRes() as never, () => ok++);
    expect(ok).toBe(2);
  });
});

describe('in-memory cache of compiled questionnaires', () => {
  it('keeps the most recently used entries', async () => {
    const { Lru } = await import('../src/interviews/compiled-cache.js');
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1); // a is now the newest
    lru.set('c', 3); // b, the oldest, goes
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
    expect(lru.size).toBe(2);
  });
});
