/**
 * A stand-in for login.microsoftonline.com for the start-of-day load test (load/start-of-day.js):
 * the v2.0 token and JWKS endpoints of the real protocol, so the API's own verification runs.
 * The authorization code is self-describing (base64url JSON of email, oid, name and nonce), so
 * k6 can play the browser without a Microsoft page; each token request waits MOCK_LATENCY_MS
 * (default 150), about what the real token endpoint takes.
 *   tsx scripts/load-mock-entra.ts           (port MOCK_ENTRA_PORT, default 4555)
 */
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const PORT = Number(process.env.MOCK_ENTRA_PORT ?? 4555);
const LATENCY = Number(process.env.MOCK_LATENCY_MS ?? 150);
const host = `http://127.0.0.1:${PORT}`;
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'load-key', alg: 'RS256', use: 'sig' };

createServer((req, res) => {
  const url = new URL(req.url ?? '/', host);
  const m = /^\/([^/]+)\/(oauth2\/v2\.0\/token|discovery\/v2\.0\/keys)$/.exec(url.pathname);
  if (!m) {
    res.writeHead(404).end();
    return;
  }
  const tid = decodeURIComponent(m[1]!);
  if (m[2] === 'discovery/v2.0/keys') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    setTimeout(() => {
      void (async () => {
        const form = new URLSearchParams(body);
        const code = JSON.parse(Buffer.from(form.get('code') ?? '', 'base64url').toString()) as {
          email: string;
          oid: string;
          name: string;
          nonce: string;
        };
        const idToken = await new SignJWT({
          tid,
          oid: code.oid,
          nonce: code.nonce,
          email: code.email,
          preferred_username: code.email,
          name: code.name,
          amr: ['pwd', 'mfa'],
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'load-key' })
          .setIssuer(`${host}/${tid}/v2.0`)
          .setAudience(form.get('client_id') ?? '')
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(privateKey);
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ id_token: idToken, token_type: 'Bearer' }));
      })();
    }, LATENCY);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Mock Entra on ${host}, ${LATENCY} ms`));
