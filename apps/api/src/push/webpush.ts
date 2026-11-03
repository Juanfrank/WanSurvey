import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { SignJWT } from 'jose';

/**
 * Web Push over the standard protocols, without a library: the message is encrypted for the
 * browser's key (RFC 8291, content coding `aes128gcm` of RFC 8188) and the sender is shown to
 * the push service with a VAPID token (RFC 8292). Only `node:crypto` and `jose` are used.
 */

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

export interface PushSubscriptionKeys {
  endpoint: string;
  /** The browser's public key, 65 bytes, base64url. */
  p256dh: string;
  /** The browser's 16-byte secret, base64url. */
  auth: string;
}

/** A new VAPID key pair: the public key (65 bytes) and the private scalar, both base64url. */
export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidPrivateKey(publicKey: string, privateKey: string): KeyObject {
  const pub = unb64u(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID_PUBLIC_KEY is not a P-256 key');
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: privateKey,
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

/** The `Authorization` header that tells the push service who is sending (valid 12 hours). */
export async function vapidAuthorization(
  endpoint: string,
  keys: { publicKey: string; privateKey: string; subject: string },
  now = Date.now(),
): Promise<string> {
  const audience = new URL(endpoint).origin;
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setAudience(audience)
    .setSubject(keys.subject)
    .setExpirationTime(Math.floor(now / 1000) + 12 * 3600)
    .sign(vapidPrivateKey(keys.publicKey, keys.privateKey));
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

/**
 * The encrypted body of a push (RFC 8291 §3): salt, record size, the sender's one-time public
 * key, and the message in a single AES-128-GCM record. `asPrivate` and `salt` are for tests.
 */
export function encryptPayload(
  sub: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  payload: Buffer,
  opts: { asPrivate?: string; salt?: Buffer } = {},
): Buffer {
  const uaPublic = unb64u(sub.p256dh);
  const auth = unb64u(sub.auth);
  if (uaPublic.length !== 65 || auth.length !== 16) throw new Error('Invalid subscription keys');
  if (payload.length > 3993) throw new Error('Payload too large for one record');

  const as = createECDH('prime256v1');
  if (opts.asPrivate) as.setPrivateKey(unb64u(opts.asPrivate));
  else as.generateKeys();
  const asPublic = as.getPublicKey();
  const secret = as.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );

  // One record: the message and the delimiter 0x02 that marks the last record.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}
