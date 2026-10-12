import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

type KeyLike = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface IssuedCode {
  claims: Record<string, unknown>;
  /** PKCE challenge from the authorize request; the token request must prove the verifier. */
  codeChallenge: string;
  clientId: string;
  /** Overrides for negative tests. */
  signWithOtherKey?: boolean;
  issuer?: string;
  audience?: string;
  expiresInSeconds?: number;
}

/**
 * A minimal stand-in for login.microsoftonline.com: the v2.0 token and JWKS endpoints,
 * speaking the same protocol so the real verification code path runs.
 */
export class MockEntra {
  private server!: Server;
  private codes = new Map<string, IssuedCode>();
  private key!: KeyLike;
  private otherKey!: KeyLike;
  private jwk!: JWK;
  host = '';
  tokenRequests: URLSearchParams[] = [];

  async start() {
    const pair = await generateKeyPair('RS256');
    this.key = pair.privateKey;
    this.otherKey = (await generateKeyPair('RS256')).privateKey;
    this.jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.host = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Simulates the user signing in at Microsoft: returns the code the browser would carry back. */
  issueCode(code: IssuedCode): string {
    const value = `code-${Math.random().toString(36).slice(2)}`;
    this.codes.set(value, code);
    return value;
  }

  private async handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) {
    const url = new URL(req.url ?? '/', this.host);
    const m = /^\/([^/]+)\/(oauth2\/v2\.0\/token|discovery\/v2\.0\/keys)$/.exec(url.pathname);
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    const tid = decodeURIComponent(m[1]!);
    if (m[2] === 'discovery/v2.0/keys') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ keys: [this.jwk] }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    this.tokenRequests.push(form);
    const issued = this.codes.get(form.get('code') ?? '');
    const verifier = form.get('code_verifier') ?? '';
    const challengeOk =
      issued && createHash('sha256').update(verifier).digest('base64url') === issued.codeChallenge;
    if (
      !issued ||
      !challengeOk ||
      form.get('client_id') !== issued.clientId ||
      !form.get('client_secret')
    ) {
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }
    this.codes.delete(form.get('code')!);
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ tid, ...issued.claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issued.issuer ?? `${this.host}/${tid}/v2.0`)
      .setAudience(issued.audience ?? issued.clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + (issued.expiresInSeconds ?? 3600))
      .sign(issued.signWithOtherKey ? this.otherKey : this.key);
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ id_token: idToken, token_type: 'Bearer', access_token: 'unused' }));
  }
}
