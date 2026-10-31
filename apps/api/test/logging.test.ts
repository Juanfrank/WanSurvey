import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { describe, expect, it } from 'vitest';
import { requestLogOptions } from '../src/common/logging.js';

/** One request through pino-http with the application's options; returns the log lines. */
async function logged(path: string, headers: Record<string, string>) {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });
  const http = pinoHttp({ ...requestLogOptions('info'), logger: pino(sink) } as never);
  const server = createServer((req, res) => {
    http(req, res);
    res.setHeader('set-cookie', 'session=secret-session-value; HttpOnly');
    res.end('ok');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    await res.text();
    await new Promise((ok) => setTimeout(ok, 50));
  } finally {
    await new Promise((ok) => server.close(ok));
  }
  return lines;
}

describe('request logging', () => {
  it('keeps cookies and the CSRF header out of the log', async () => {
    const lines = await logged('/api/v1/auth/me', {
      cookie: 'session=abc-secret-cookie',
      'x-csrf-token': 'csrf-secret-value',
    });
    const text = JSON.stringify(lines);
    expect(lines.length).toBeGreaterThan(0);
    expect(text).not.toContain('abc-secret-cookie');
    expect(text).not.toContain('csrf-secret-value');
    expect(text).not.toContain('secret-session-value');
  });

  it('masks the tokens that links carry in their path and query', async () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const lines = await logged(`/api/v1/public/s/${token}/submit?token=${token}&x=1`, {});
    const text = JSON.stringify(lines);
    expect(text).not.toContain(token);
    expect(text).toContain('/api/v1/public/s/…/submit');
  });
});
