import { describe, expect, it } from 'vitest';
import { newSecret, sign, signedHeaders, verify } from '../src/webhooks/signing.js';
import { isPublicAddress, resolveTarget, UnsafeUrlError } from '../src/webhooks/url-guard.js';

describe('webhook signatures (Standard Webhooks)', () => {
  it('matches the specification’s own example', () => {
    expect(
      sign(
        'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
        'msg_p5jXN8AQM9LWM0D4loKWxJek',
        1614265330,
        '{"test": 2432232314}',
      ),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('is checked by a receiver, with both secrets while one is rotated', () => {
    const [a, b] = [newSecret(), newSecret()];
    const ts = Math.floor(Date.now() / 1000);
    const h = signedHeaders([a, b], 'msg_1', ts, '{"x":1}');
    expect(h['webhook-signature'].split(' ')).toHaveLength(2);
    expect(verify(a, h, '{"x":1}')).toBe(true);
    expect(verify(b, h, '{"x":1}')).toBe(true);
    expect(verify(a, h, '{"x":2}')).toBe(false);
    expect(verify(newSecret(), h, '{"x":1}')).toBe(false);
    // Too old: a captured delivery cannot be replayed later.
    expect(verify(a, h, '{"x":1}', 300, ts + 3600)).toBe(false);
  });
});

describe('webhook address guard', () => {
  it('refuses private, loopback, link-local and reserved addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])
      expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('accepts only https, with no credentials, and no private target', async () => {
    await expect(resolveTarget('http://8.8.8.8/hook')).rejects.toThrow(UnsafeUrlError);
    await expect(resolveTarget('https://user:pw@8.8.8.8/hook')).rejects.toThrow(UnsafeUrlError);
    await expect(resolveTarget('https://169.254.169.254/latest/meta-data')).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(resolveTarget('https://[::1]/hook')).rejects.toThrow(UnsafeUrlError);
    await expect(resolveTarget('not a url')).rejects.toThrow(UnsafeUrlError);
    await expect(resolveTarget('https://nonexistent.invalid/hook')).rejects.toThrow(UnsafeUrlError);
    const ok = await resolveTarget('https://8.8.8.8/hook');
    expect(ok.address).toBe('8.8.8.8');
    // For tests and development, plain http on a private address is allowed on request.
    expect((await resolveTarget('http://127.0.0.1:9999/x', true)).address).toBe('127.0.0.1');
  });
});
