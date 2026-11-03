import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AcsSms, isE164, isOptOut, maskPhone, segments, smsText } from '../src/sms/sms.js';

describe('SMS helpers', () => {
  it('knows E.164 numbers', () => {
    for (const ok of ['+51987654321', '+14155552671', '+442071838750'])
      expect(isE164(ok), ok).toBe(true);
    for (const bad of [
      '987654321',
      '+0123456789',
      '+51 987 654 321',
      '+5198',
      '+519876543210123456',
      '',
    ])
      expect(isE164(bad), bad).toBe(false);
    expect(maskPhone('+51987654321')).toBe('+51••••21');
  });

  it('counts the messages a text takes', () => {
    expect(segments('Hola, ¿cómo está?')).toMatchObject({ count: 1, encoding: 'ucs2' }); // í is outside GSM-7
    expect(segments('Hola, como esta?')).toMatchObject({ count: 1, encoding: 'gsm7', length: 16 });
    expect(segments('a'.repeat(160)).count).toBe(1);
    expect(segments('a'.repeat(161)).count).toBe(2);
    expect(segments('a'.repeat(306)).count).toBe(2);
    expect(segments('a'.repeat(307)).count).toBe(3);
    // Extension characters take two places.
    expect(segments('€'.repeat(80))).toMatchObject({ count: 1, length: 160 });
    expect(segments('€'.repeat(81)).count).toBe(2);
    // One character outside the set moves the whole text to UCS-2.
    expect(segments(`${'a'.repeat(70)}\u{1F600}`)).toMatchObject({ count: 2, encoding: 'ucs2' });
    expect(segments('a'.repeat(70)).count).toBe(1);
  });

  it('recognises a reply that asks to stop, in Spanish and English', () => {
    for (const yes of ['STOP', 'stop', ' Baja ', 'BAJA.', 'cancelar', 'Unsubscribe', 'parar'])
      expect(isOptOut(yes), yes).toBe(true);
    for (const no of ['hola', 'no puedo ahora, llámeme', 'gracias', 'stop calling me please'])
      expect(isOptOut(no), no).toBe(false);
  });

  it('writes a short message with the link and the way out', () => {
    const t = smsText('invitation', 'es', { link: 'https://x.org/t/c/abc', firstName: 'Ana' });
    expect(t).toContain('https://x.org/t/c/abc');
    expect(t).toContain('BAJA');
    expect(smsText('reminder', 'en', { link: 'https://x.org/t/c/abc' })).toContain('STOP');
  });
});

describe('Azure Communication Services adapter', () => {
  const key = Buffer.from('secret-key-0123456789').toString('base64');
  const conn = `endpoint=https://res.communication.azure.com/;accesskey=${key}`;
  const at = new Date('2026-11-03T10:00:00Z');

  it('signs the request as the service documents', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const sms = new AcsSms(
      conn,
      '+15555550100',
      async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return { ok: true, status: 202, json: async () => ({ value: [{ successful: true }] }) };
      },
      () => at,
    );
    await sms.send({ to: '+51987654321', text: 'Hola' });
    const c = calls[0]!;
    expect(c.url).toBe('https://res.communication.azure.com/sms?api-version=2021-03-07');
    expect(JSON.parse(c.body)).toMatchObject({
      from: '+15555550100',
      message: 'Hola',
      smsRecipients: [{ to: '+51987654321' }],
    });
    const hash = createHash('sha256').update(c.body).digest('base64');
    expect(c.headers['x-ms-content-sha256']).toBe(hash);
    const sig = createHmac('sha256', Buffer.from(key, 'base64'))
      .update(
        `POST\n/sms?api-version=2021-03-07\n${at.toUTCString()};res.communication.azure.com;${hash}`,
      )
      .digest('base64');
    expect(c.headers.authorization).toBe(
      `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${sig}`,
    );
  });

  it('fails when the service refuses the message or answers an error', async () => {
    const refused = new AcsSms(conn, '+1', async () => ({
      ok: true,
      status: 202,
      json: async () => ({
        value: [{ successful: false, httpStatusCode: 400, errorMessage: 'bad number' }],
      }),
    }));
    await expect(refused.send({ to: '+51987654321', text: 'x' })).rejects.toThrow(/bad number/);
    const down = new AcsSms(conn, '+1', async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));
    await expect(down.send({ to: '+51987654321', text: 'x' })).rejects.toThrow(/503/);
    expect(() => new AcsSms('nonsense', '+1')).toThrow(/endpoint=/);
  });
});
