import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConnectionString, scrub, Telemetry } from '../src/observability/app-insights.js';

const KEY = '01234567-89ab-4def-8123-456789abcdef';

/** What the test reads of an envelope. */
interface Envelope {
  name: string;
  iKey: string;
  tags: Record<string, string>;
  data: {
    baseType: string;
    baseData: {
      exceptions: { message: string }[];
      severityLevel: number;
      properties: Record<string, string>;
      name: string;
      responseCode: string;
      success: boolean;
      duration: string;
    };
  };
}

describe('the connection string', () => {
  it('gives the key and the ingestion address, or nothing', () => {
    expect(
      parseConnectionString(
        `InstrumentationKey=${KEY};IngestionEndpoint=https://westus-0.in.applicationinsights.azure.com/;LiveEndpoint=https://x`,
      ),
    ).toEqual({ key: KEY, endpoint: 'https://westus-0.in.applicationinsights.azure.com/' });
    expect(parseConnectionString(`InstrumentationKey=${KEY}`)?.endpoint).toBe(
      'https://dc.services.visualstudio.com/',
    );
    expect(parseConnectionString('InstrumentationKey=not-a-guid')).toBeNull();
    expect(parseConnectionString(`InstrumentationKey=${KEY};IngestionEndpoint=ftp://x`)).toBeNull();
    expect(parseConnectionString('')).toBeNull();
  });
});

describe('what leaves the system is cleaned first', () => {
  it('removes e-mail addresses, numbers, credentials and query strings', () => {
    expect(scrub('Could not write to ana.perez@instituto.example')).toBe(
      'Could not write to [email]',
    );
    expect(scrub('Call +1 (809) 555-0123 failed for 001-1234567-8')).toBe(
      'Call [number] failed for [number]',
    );
    expect(scrub('connect mssql://survey_rw:Rw-Pass-1!@sql.example.org:1433/db failed')).toBe(
      'connect mssql://[redacted]@sql.example.org:1433/db failed',
    );
    expect(
      scrub('password=hunter2; token: abc.def Authorization: Bearer eyJhbGciOi.x.y'),
    ).not.toMatch(/hunter2|abc\\.def|eyJ/);
    expect(scrub('GET /api/v1/cases?phone=8095550123&name=Juan failed')).toBe(
      'GET /api/v1/cases?[query] failed',
    );
  });

  it('removes the values a database error quotes, and keeps the names of objects and the identifiers', () => {
    expect(
      scrub("Conversion failed when converting the nvarchar value 'Juan Pérez' to data type int."),
    ).toContain("'[value]'");
    expect(
      scrub(
        'Violation of UNIQUE KEY constraint. The duplicate key value is (ana@x.org, 12345678).',
      ),
    ).toBe('Violation of UNIQUE KEY constraint. The duplicate key value is ([value]).');
    expect(scrub("Invalid object name 'bi_dim_proyecto'.")).toBe(
      "Invalid object name 'bi_dim_proyecto'.",
    );
    const id = '01a1e5e6-2a0b-7629-89ef-862e6cb3ea42';
    expect(scrub(`case ${id} at 2026-11-18T19:48:40.871Z`)).toBe(
      `case ${id} at 2026-11-18T19:48:40.871Z`,
    );
    expect(scrub('x'.repeat(5000), 100)).toHaveLength(101);
  });
});

describe('the reporting', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });
  const ingest = async () => {
    const received: { url: string; body: Envelope[] }[] = [];
    server = createServer((req, res) => {
      let text = '';
      req.on('data', (c: Buffer) => (text += c.toString()));
      req.on('end', () => {
        received.push({ url: req.url ?? '', body: JSON.parse(text) });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
    const port = (server.address() as AddressInfo).port;
    return {
      received,
      conn: `InstrumentationKey=${KEY};IngestionEndpoint=http://127.0.0.1:${port}/`,
    };
  };

  it('does nothing when it is off', async () => {
    const t = new Telemetry();
    expect(t.enabled).toBe(false);
    t.trackException(new Error('x'));
    await t.flush();
    expect(t.init({ connectionString: 'nope', role: 'wansurvey-api', version: '1' })).toBe(false);
    expect(t.enabled).toBe(false);
  });

  it('sends an exception and a failed request as Application Insights envelopes, cleaned', async () => {
    const { received, conn } = await ingest();
    const t = new Telemetry();
    t.init({ connectionString: conn, role: 'wansurvey-api', version: '9.9.9', intervalMs: 0 });
    t.trackException(new Error('Could not e-mail ana@x.org, phone 8095550123'), {
      route: '/cases/:id',
      who: 'ana@x.org',
    });
    t.trackRequest({ method: 'GET', route: '/cases/:id', status: 500, durationMs: 1234 });
    await t.flush();
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/v2/track');
    const [ex, rq] = received[0]!.body;
    expect(ex!.name).toBe(`Microsoft.ApplicationInsights.${KEY.replace(/-/g, '')}.Exception`);
    expect(ex!.iKey).toBe(KEY);
    expect(ex!.tags).toMatchObject({
      'ai.cloud.role': 'wansurvey-api',
      'ai.application.ver': '9.9.9',
      'ai.location.ip': '0.0.0.0',
    });
    expect(ex!.data.baseType).toBe('ExceptionData');
    expect(ex!.data.baseData.exceptions[0]!.message).toBe(
      'Could not e-mail [email], phone [number]',
    );
    expect(ex!.data.baseData.severityLevel).toBe(3);
    expect(ex!.data.baseData.properties).toEqual({ route: '/cases/:id', who: '[email]' });
    expect(rq!.data.baseType).toBe('RequestData');
    expect(rq!.data.baseData).toMatchObject({
      name: 'GET /cases/:id',
      responseCode: '500',
      success: false,
      duration: '00:00:01.234',
    });
    expect(JSON.stringify(received)).not.toMatch(/ana@x\\.org|8095550123/);
  });

  it('does not let a failure repeat without end, and never throws when the service is down', async () => {
    const t = new Telemetry();
    t.init({
      connectionString: `InstrumentationKey=${KEY};IngestionEndpoint=http://127.0.0.1:1/`,
      role: 'wansurvey-worker',
      version: '1',
      intervalMs: 0,
    });
    for (let i = 0; i < 200; i++) t.trackException(new Error(`failure ${i}`));
    await expect(t.flush(500)).resolves.toBeUndefined();
    // Dropped, not kept for ever: a second flush has nothing to send.
    await expect(t.flush(500)).resolves.toBeUndefined();
    const { received, conn } = await ingest();
    const u = new Telemetry();
    u.init({ connectionString: conn, role: 'wansurvey-api', version: '1', intervalMs: 0 });
    for (let i = 0; i < 200; i++) u.trackException(new Error(`failure ${i}`));
    await u.flush();
    expect(received[0]!.body.length).toBe(30);
  });
});
