import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signatures as the Standard Webhooks specification says: HMAC-SHA256 over `id.timestamp.body`
 * with the bytes of the secret (the part of `whsec_<base64>` after the prefix), sent as
 * `v1,<base64>` in `webhook-signature` (several, space separated, while a secret is rotated).
 */
export const newSecret = () => `whsec_${randomBytes(32).toString('base64')}`;

const keyOf = (secret: string) =>
  Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');

export function sign(secret: string, id: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest();
  return `v1,${mac.toString('base64')}`;
}

/** The three headers of a delivery, signed with every secret currently valid. */
export function signedHeaders(secrets: string[], id: string, timestamp: number, body: string) {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': secrets.map((s) => sign(s, id, timestamp, body)).join(' '),
  };
}

/** What a receiver does; used by the tests. */
export function verify(
  secret: string,
  headers: Record<string, string | undefined>,
  body: string,
  toleranceSeconds = 300,
  now = Date.now() / 1000,
): boolean {
  const id = headers['webhook-id'];
  const ts = Number(headers['webhook-timestamp']);
  if (!id || !Number.isFinite(ts) || Math.abs(now - ts) > toleranceSeconds) return false;
  const expected = Buffer.from(sign(secret, id, ts, body));
  return (headers['webhook-signature'] ?? '').split(' ').some((s) => {
    const got = Buffer.from(s);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
