import { Logger } from '@nestjs/common';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Idempotency key so retries never send the same e-mail twice. */
  idempotencyKey?: string;
}

/**
 * Provider-agnostic mail port. SES / Postmark / SendGrid / SMTP adapters plug in here
 * (slice 9); until then mail is logged (development) or kept in memory (tests).
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol('MAILER');

export class ConsoleMailer implements Mailer {
  private readonly logger = new Logger('Mailer');
  async send(message: MailMessage): Promise<void> {
    this.logger.log(`To: ${message.to} | ${message.subject}\n${message.text}`);
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
