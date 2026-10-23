import { Logger } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Sender name shown before the configured address. */
  fromName?: string;
  /** Extra headers (List-Unsubscribe, the invitation id for provider webhooks…). */
  headers?: Record<string, string>;
  /** Idempotency key so retries never send the same e-mail twice. */
  idempotencyKey?: string;
}

/**
 * Provider-agnostic mail port: logged (development), written as files (development and
 * end-to-end tests), kept in memory (unit tests) or sent by SMTP, which every provider
 * (SES, Postmark, SendGrid…) offers.
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol('MAILER');

/**
 * Logs each message. Messages carry sign-in, reset and respondent links, which are bearer
 * tokens, so their text is logged only outside production.
 */
export class ConsoleMailer implements Mailer {
  private readonly logger = new Logger('Mailer');
  constructor(private readonly withText = true) {}
  async send(message: MailMessage): Promise<void> {
    this.logger.log(
      this.withText
        ? `To: ${message.to} | ${message.subject}\n${message.text}`
        : `To: ${message.to} | ${message.subject} (not sent: set MAILER=smtp)`,
    );
  }
}

export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    if (
      message.idempotencyKey &&
      this.sent.some((m) => m.idempotencyKey === message.idempotencyKey)
    )
      return;
    this.sent.push(message);
  }
  last(to?: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => !to || m.to === to);
  }
}

/** One JSON file per message, named so a folder listing is in sending order. */
export class FileMailer implements Mailer {
  private n = 0;
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  async send(message: MailMessage): Promise<void> {
    const name = `${Date.now()}-${String(++this.n).padStart(6, '0')}.json`;
    writeFileSync(join(this.dir, name), JSON.stringify(message, null, 2));
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: nodemailer.Transporter;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(message: MailMessage): Promise<void> {
    const address = this.from.match(/<([^>]+)>/)?.[1] ?? this.from;
    await this.transport.sendMail({
      from: message.fromName ? { name: message.fromName, address } : this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      headers: {
        ...(message.headers ?? {}),
        ...(message.idempotencyKey ? { 'X-Idempotency-Key': message.idempotencyKey } : {}),
      },
    });
  }
}
