import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';

export interface SmsMessage {
  /** E.164, e.g. +51987654321. */
  to: string;
  text: string;
  /** So that a retry never sends the same message twice (where the provider supports it). */
  idempotencyKey?: string;
}

/**
 * Provider-agnostic SMS port, like the mailer: logged (development), written as files
 * (development and browser tests), kept in memory (tests), or sent through Azure
 * Communication Services. Another provider is one more class.
 */
export interface SmsProvider {
  send(message: SmsMessage): Promise<void>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export class ConsoleSms implements SmsProvider {
  private readonly logger = new Logger('Sms');
  constructor(private readonly withText = true) {}
  async send(m: SmsMessage): Promise<void> {
    this.logger.log(
      this.withText ? `To: ${m.to} | ${m.text}` : `To: ${m.to} (not sent: set SMS_PROVIDER)`,
    );
  }
}

export class MemorySms implements SmsProvider {
  readonly sent: SmsMessage[] = [];
  /** Set to make the next sends fail, as a provider that is down would. */
  failWith: Error | null = null;
  async send(m: SmsMessage): Promise<void> {
    if (this.failWith) throw this.failWith;
    if (m.idempotencyKey && this.sent.some((s) => s.idempotencyKey === m.idempotencyKey)) return;
    this.sent.push(m);
  }
  last(to?: string): SmsMessage | undefined {
    return [...this.sent].reverse().find((m) => !to || m.to === to);
  }
}

export class FileSms implements SmsProvider {
  private n = 0;
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  async send(m: SmsMessage): Promise<void> {
    const name = `${Date.now()}-${String(++this.n).padStart(6, '0')}.json`;
    writeFileSync(join(this.dir, name), JSON.stringify(m, null, 2));
  }
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Azure Communication Services SMS through its REST API, signed with the access key of the
 * connection string (`endpoint=https://….communication.azure.com/;accesskey=…`). No SDK: one
 * request. `from` is a number or short code the resource owns.
 */
export class AcsSms implements SmsProvider {
  private readonly endpoint: URL;
  private readonly key: Buffer;
  constructor(
    connectionString: string,
    private readonly from: string,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init) as ReturnType<Fetch>,
    private readonly now: () => Date = () => new Date(),
  ) {
    const parts = Object.fromEntries(
      connectionString.split(';').map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()];
      }),
    );
    if (!parts.endpoint || !parts.accesskey)
      throw new Error('SMS_CONNECTION_STRING needs endpoint= and accesskey=');
    this.endpoint = new URL(parts.endpoint);
    this.key = Buffer.from(parts.accesskey, 'base64');
  }

  async send(m: SmsMessage): Promise<void> {
    const path = '/sms?api-version=2021-03-07';
    const body = JSON.stringify({
      from: this.from,
      message: m.text,
      smsRecipients: [{ to: m.to }],
      smsSendOptions: { enableDeliveryReport: false },
    });
    const date = this.now().toUTCString();
    const hash = createHash('sha256').update(body).digest('base64');
    const toSign = `POST\n${path}\n${date};${this.endpoint.host};${hash}`;
    const signature = createHmac('sha256', this.key).update(toSign).digest('base64');
    const res = await this.fetcher(`${this.endpoint.origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ms-date': date,
        'x-ms-content-sha256': hash,
        authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
      },
      body,
    });
    if (!res.ok) throw new Error(`SMS provider answered ${res.status}`);
    const answer = (await res.json()) as {
      value?: { successful?: boolean; httpStatusCode?: number; errorMessage?: string }[];
    };
    const bad = answer.value?.find((v) => v.successful === false);
    if (bad) throw new Error(`SMS refused (${bad.httpStatusCode}): ${bad.errorMessage ?? ''}`);
  }
}

// Numbers and length

/** E.164: a plus, a country code that does not start with 0, up to 15 digits in all. */
export const isE164 = (v: string) => /^\+[1-9]\d{7,14}$/.test(v);

export const maskPhone = (v: string | null) => (v ? `${v.slice(0, 3)}••••${v.slice(-2)}` : null);

const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';

/**
 * How many messages the text takes: GSM-7 holds 160 characters (153 each when joined), and
 * any other character (an accent outside the set, an emoji) puts the whole text in UCS-2:
 * 70 characters (67 each when joined).
 */
export function segments(text: string): {
  count: number;
  encoding: 'gsm7' | 'ucs2';
  length: number;
} {
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7.includes(ch)) units += 1;
    else if (GSM7_EXT.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm)
    return { count: units <= 160 ? 1 : Math.ceil(units / 153), encoding: 'gsm7', length: units };
  const length = [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return { count: length <= 70 ? 1 : Math.ceil(length / 67), encoding: 'ucs2', length };
}

/** Words a person replies to be left alone; compared whole, without accents or case. */
const STOP = new Set([
  'stop',
  'baja',
  'cancelar',
  'cancel',
  'unsubscribe',
  'parar',
  'no',
  'salir',
  'quit',
  'end',
]);
export const isOptOut = (text: string) =>
  STOP.has(
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}]/gu, ''),
  );

/** What goes in the message: short, with the link and the way to stop. */
export function smsText(
  kind: 'invitation' | 'reminder',
  language: string,
  vars: { firstName?: string; link: string },
): string {
  const name = vars.firstName ? ` ${vars.firstName}` : '';
  if (language.startsWith('en'))
    return kind === 'invitation'
      ? `Hello${name}, you are invited to a short survey: ${vars.link} Reply STOP to opt out.`
      : `Reminder${name}: your survey is still open: ${vars.link} Reply STOP to opt out.`;
  return kind === 'invitation'
    ? `Hola${name}, le invitamos a una encuesta breve: ${vars.link} Responda BAJA para no recibir más.`
    : `Recordatorio${name}: su encuesta sigue abierta: ${vars.link} Responda BAJA para no recibir más.`;
}
