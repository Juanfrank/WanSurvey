import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where the E2E API writes e-mails (MAILER=file). */
export const MAIL_DIR = join(tmpdir(), 'wansurvey-e2e-mail');

export function clearMail() {
  rmSync(MAIL_DIR, { recursive: true, force: true });
  mkdirSync(MAIL_DIR, { recursive: true });
}

export interface SentMail {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

/** E-mails sent so far, oldest first. */
export function sentMail(): SentMail[] {
  return readdirSync(MAIL_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(MAIL_DIR, f), 'utf8')) as SentMail);
}
