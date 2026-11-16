import { Connection, Request } from 'tedious';
import { parseMssqlUrl } from '../db/mssql/connection.js';

/** The steps of an installation that the wizard can see from the application's own user. */
export type StepId = 'server' | 'login' | 'tables';
export type StepState = 'ok' | 'pending' | 'blocked';
export interface Step {
  id: StepId;
  state: StepState;
  /** Why it is pending, in a code the web app words: no secrets, no names. */
  reason?: 'unreachable' | 'login_failed' | 'not_visible' | 'other';
}
export interface Diagnosis {
  ready: boolean;
  steps: Step[];
}

interface DriverError {
  code?: string;
  number?: number;
  message?: string;
  originalError?: DriverError;
  cause?: DriverError;
}

/** What went wrong with the database, from the error the driver gave. */
export function classify(e: unknown): 'unreachable' | 'login_failed' | 'not_visible' | 'other' {
  const err = e as DriverError;
  const inner = err?.originalError ?? err?.cause ?? err;
  const code = String(err?.code ?? inner?.code ?? '');
  const number = Number(err?.number ?? inner?.number ?? 0);
  const message = `${err?.message ?? ''} ${inner?.message ?? ''}`;
  if (code === 'ELOGIN' || number === 18456 || /Login failed/i.test(message)) return 'login_failed';
  // Invalid object name, or no permission on it: the user cannot see the tables.
  if ([208, 229, 230, 262, 297].includes(number)) return 'not_visible';
  if (
    ['ESOCKET', 'ETIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(
      code,
    ) ||
    /Failed to connect|Could not connect|getaddrinfo|ECONNREFUSED|timeout/i.test(message)
  )
    return 'unreachable';
  return 'other';
}

/** One connection (no pool: a pool keeps retrying a failed sign-in for as long as it may wait). */
function open(url: string): Promise<Connection> {
  const config = parseMssqlUrl(url);
  const options = { ...config.options, connectTimeout: 5_000, requestTimeout: 8_000 };
  const conn = new Connection({ ...config, options });
  return new Promise((ok, fail) => {
    conn.on('error', () => undefined);
    conn.connect((e) => (e ? fail(e) : ok(conn)));
  });
}

const run = (conn: Connection, text: string) =>
  new Promise<void>((ok, fail) => {
    conn.execSql(new Request(text, (e) => (e ? fail(e) : ok())));
  });

/**
 * Where an installation stands, seen with the application's own user (DATABASE_URL): the server
 * answers, the user can sign in, and it can read the tables. Nothing is written. Without the owner
 * (not available here) the last step cannot tell "the tables are not made" from "the permissions are
 * not granted": the wizard says both and gives both scripts.
 */
export async function diagnose(url: string): Promise<Diagnosis> {
  const steps: Step[] = [
    { id: 'server', state: 'pending' },
    { id: 'login', state: 'blocked' },
    { id: 'tables', state: 'blocked' },
  ];
  let conn: Connection;
  try {
    conn = await open(url);
  } catch (e) {
    const reason = classify(e);
    // A refused sign-in means the server answered.
    if (reason === 'login_failed') {
      steps[0] = { id: 'server', state: 'ok' };
      steps[1] = { id: 'login', state: 'pending', reason };
    } else steps[0] = { id: 'server', state: 'pending', reason };
    return { ready: false, steps };
  }
  try {
    steps[0] = { id: 'server', state: 'ok' };
    steps[1] = { id: 'login', state: 'ok' };
    try {
      // No row is read: the statement only has to resolve (the default schema of the user) and be allowed.
      await run(conn, 'SELECT TOP 0 1 AS x FROM tenants');
    } catch (e) {
      steps[2] = { id: 'tables', state: 'pending', reason: classify(e) };
      return { ready: false, steps };
    }
    steps[2] = { id: 'tables', state: 'ok' };
    return { ready: true, steps };
  } finally {
    conn.close();
  }
}
