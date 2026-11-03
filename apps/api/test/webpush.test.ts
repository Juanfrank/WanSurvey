import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { jwtVerify, importJWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { encryptPayload, generateVapidKeys, vapidAuthorization } from '../src/push/webpush.js';

const unb64u = (s: string) => Buffer.from(s, 'base64url');

describe('Web Push encryption (RFC 8291)', () => {
  // The example of RFC 8291, appendix A.
  const example = {
    plaintext: 'When I grow up, I want to be a watermelon',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    uaPublic:
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };

  it('produces the body the RFC gives for its example', () => {
    const body = encryptPayload(
      { p256dh: example.uaPublic, auth: example.auth },
      Buffer.from(example.plaintext),
      { asPrivate: example.asPrivate, salt: unb64u(example.salt) },
    );
    expect(body.toString('base64url')).toBe(example.body);
  });

  it('can be read by the browser’s side with its private key', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.from('0123456789abcdef');
    const message = Buffer.from(JSON.stringify({ title: 'Tiene 2 llamadas pendientes' }));
    const body = encryptPayload(
      { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
      message,
    );
    const salt = body.subarray(0, 16);
    expect(body.readUInt32BE(16)).toBe(4096);
    const idlen = body[20]!;
    const asPublic = body.subarray(21, 21 + idlen);
    const cipherAndTag = body.subarray(21 + idlen);
    const secret = ua.computeSecret(asPublic);
    const ikm = Buffer.from(
      hkdfSync(
        'sha256',
        secret,
        auth,
        Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]),
        32,
      ),
    );
    const cek = Buffer.from(
      hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
    );
    const nonce = Buffer.from(
      hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
    );
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(cipherAndTag.subarray(-16));
    const plain = Buffer.concat([d.update(cipherAndTag.subarray(0, -16)), d.final()]);
    expect(plain.at(-1)).toBe(2);
    expect(plain.subarray(0, -1).toString()).toBe(message.toString());
  });

  it('refuses keys of the wrong size and a message too large for one record', () => {
    expect(() => encryptPayload({ p256dh: 'AAAA', auth: 'AAAA' }, Buffer.from('x'))).toThrow(
      /Invalid subscription/,
    );
    expect(() =>
      encryptPayload({ p256dh: example.uaPublic, auth: example.auth }, Buffer.alloc(4000)),
    ).toThrow(/too large/);
  });
});

describe('VAPID', () => {
  it('signs a token a push service can verify with the public key', async () => {
    const keys = { ...generateVapidKeys(), subject: 'mailto:admin@example.org' };
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(m[2]).toBe(keys.publicKey);
    const pub = unb64u(keys.publicKey);
    const jwk = await importJWK(
      {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
      'ES256',
    );
    const { payload, protectedHeader } = await jwtVerify(m[1]!, jwk, {
      audience: 'https://fcm.googleapis.com',
    });
    expect(protectedHeader.alg).toBe('ES256');
    expect(payload.sub).toBe('mailto:admin@example.org');
    expect(payload.exp! - Date.now() / 1000).toBeLessThanOrEqual(12 * 3600);
  });

  it('makes keys of the right shape', () => {
    const k = generateVapidKeys();
    expect(unb64u(k.publicKey)).toHaveLength(65);
    expect(unb64u(k.privateKey)).toHaveLength(32);
  });
});
