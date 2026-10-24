import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManagedIdentity } from '../src/exports/storage.js';

/** The App Service identity endpoint, as the Storage SDK's credential calls it. */
describe('managed identity tokens', () => {
  const calls: URL[] = [];
  const headers: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    calls.push(url);
    headers.push(req.headers['x-identity-header'] as string | undefined);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        access_token: `token-${calls.length}`,
        expires_on: String(Math.floor(Date.now() / 1000) + 3600),
      }),
    );
  });
  let endpoint: string;
  beforeAll(async () => {
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/msi/token`;
  });
  afterAll(() => {
    server.close();
  });

  it('asks for the storage resource as the user-assigned identity, and reuses the token', async () => {
    const id = new ManagedIdentity('client-123', {
      IDENTITY_ENDPOINT: endpoint,
      IDENTITY_HEADER: 'secret-header',
    });
    const a = await id.getToken('https://storage.azure.com/.default');
    const b = await id.getToken(['https://storage.azure.com/.default']);
    expect(a.token).toBe('token-1');
    expect(b.token).toBe('token-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.searchParams.get('resource')).toBe('https://storage.azure.com/');
    expect(calls[0]!.searchParams.get('client_id')).toBe('client-123');
    expect(calls[0]!.searchParams.get('api-version')).toBe('2019-08-01');
    expect(headers[0]).toBe('secret-header');
    expect(a.expiresOnTimestamp).toBeGreaterThan(Date.now() + 3_000_000);
  });
});
