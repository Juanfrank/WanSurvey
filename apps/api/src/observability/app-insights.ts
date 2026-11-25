import { randomUUID } from 'node:crypto';

/**
 * Error reporting to Azure Application Insights, without its SDK: the failures that matter (an
 * exception no handler caught, a request that ended in 5xx, a job that failed for good) are sent to
 * the ingestion API as small JSON envelopes. What is sent is cleaned first: e-mail addresses, long
 * numbers, passwords and tokens, query strings and quoted values are removed, and neither request
 * bodies, headers, cookies, user names nor the client's address are ever included.
 *
 * Off unless `APPLICATIONINSIGHTS_CONNECTION_STRING` is set (App Service's own name for it).
 */

/** The ingestion address and key of a connection string, or null if it is not one. */
export function parseConnectionString(text: string): { key: string; endpoint: string } | null {
  const parts = Object.fromEntries(
    text
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).toLowerCase(), p.slice(i + 1)] as const;
      }),
  );
  const key = parts.instrumentationkey ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return null;
  let endpoint = parts.ingestionendpoint ?? 'https://dc.services.visualstudio.com/';
  if (!/^https?:\/\//i.test(endpoint)) return null;
  if (!endpoint.endsWith('/')) endpoint += '/';
  return { key, endpoint };
}

/**
 * Takes the personal and secret data out of a text that is going to leave the system: addresses,
 * numbers a person could be reached by, credentials in URLs and `key=value` pairs, query strings,
 * and the values that database errors quote. Identifiers (UUIDs, dates, names of objects) stay, since
 * they say where the error was. Best effort: free text cannot be guaranteed clean, so messages are
 * also cut short.
 */
export function scrub(text: string, max = 2000): string {
  // What must survive the number rule goes away for a moment.
  const keep: string[] = [];
  const hold = (m: string) => `\uE000${keep.push(m) - 1}\uE001`;
  let out = text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, hold)
    .replace(
      /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?/g,
      hold,
    )
    // user:password@ in a URL
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    // password=…, token: …, Authorization: Bearer …
    .replace(
      /\b(password|passwd|pwd|secret|token|api[-_]?key|key|authorization|cookie|sig|signature)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s;,"']+/gi,
      '$1$2[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]')
    // the query string of a URL or path
    .replace(/(\/[\w./-]*)\?[^\s"')]*/g, '$1?[query]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    // The value a database error quotes: 'Juan Pérez', (a@b.org), not the name of an object.
    .replace(/'([^']*)'/g, (m, v: string) =>
      /^[\w.[\]$-]{1,64}$/.test(v) && !/^\d{5,}$/.test(v) ? m : "'[value]'",
    )
    .replace(/(duplicate key value is )\([^)]*\)/gi, '$1([value])')
    // 7 or more digits, with the separators of a phone number or an identity card
    .replace(/\+?\d[\d\s().-]{5,}\d/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '[number]' : m));
  out = out.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => keep[Number(i)]!);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

export interface TelemetryOptions {
  connectionString: string;
  /** `wansurvey-api` or `wansurvey-worker`: the cloud role name that Application Insights groups by. */
  role: string;
  version: string;
  /** For tests. */
  fetcher?: typeof fetch;
  /** Milliseconds between the sends of what has gathered; 0: only when asked. */
  intervalMs?: number;
}

interface Envelope {
  name: string;
  time: string;
  iKey: string;
  tags: Record<string, string>;
  data: { baseType: string; baseData: Record<string, unknown> };
}

const SEND_TIMEOUT_MS = 5_000;
const MAX_QUEUE = 100;
/** Exceptions per minute: a failure that repeats must not become a flood. */
const MAX_PER_MINUTE = 30;

export class Telemetry {
  private target: { key: string; endpoint: string } | null = null;
  private options: TelemetryOptions | null = null;
  private queue: Envelope[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private window = { start: 0, count: 0 };
  private flushing: Promise<void> | null = null;

  get enabled(): boolean {
    return this.target !== null;
  }

  /** Starts (or restarts) reporting; false if the connection string is not valid. */
  init(options: TelemetryOptions): boolean {
    this.stop();
    const target = parseConnectionString(options.connectionString);
    if (!target) return false;
    this.target = target;
    this.options = options;
    const every = options.intervalMs ?? 5_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.flush(), every);
      this.timer.unref();
    }
    return true;
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.target = null;
    this.queue = [];
  }

  private envelope(
    kind: 'Exception' | 'Request',
    baseType: string,
    baseData: Record<string, unknown>,
  ): void {
    if (!this.target || !this.options) return;
    const compact = this.target.key.replace(/-/g, '');
    this.queue.push({
      name: `Microsoft.ApplicationInsights.${compact}.${kind}`,
      time: new Date().toISOString(),
      iKey: this.target.key,
      tags: {
        'ai.cloud.role': this.options.role,
        'ai.application.ver': this.options.version,
        // The client's address is not collected.
        'ai.location.ip': '0.0.0.0',
        'ai.internal.sdkVersion': 'wansurvey:1',
      },
      data: { baseType, baseData },
    });
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
  }

  /** An exception, cleaned. `severity` 3 is an error, 4 is critical. */
  trackException(
    error: unknown,
    properties: Record<string, string> = {},
    severity: 3 | 4 = 3,
  ): void {
    if (!this.target) return;
    const now = Date.now();
    if (now - this.window.start > 60_000) this.window = { start: now, count: 0 };
    if (++this.window.count > MAX_PER_MINUTE) return;
    const e = error instanceof Error ? error : new Error(String(error));
    this.envelope('Exception', 'ExceptionData', {
      ver: 2,
      exceptions: [
        {
          typeName: e.name || 'Error',
          message: scrub(e.message || e.name || 'Error'),
          hasFullStack: !!e.stack,
          ...(e.stack ? { stack: scrub(e.stack.split('\n').slice(1, 40).join('\n'), 8000) } : {}),
        },
      ],
      severityLevel: severity,
      properties: Object.fromEntries(
        Object.entries(properties).map(([k, v]) => [k, scrub(v, 300)]),
      ),
    });
  }

  /** A request that failed: its method, the route pattern (not the address), status and duration. */
  trackRequest(r: { method: string; route: string; status: number; durationMs: number }): void {
    if (!this.target) return;
    const ms = Math.max(0, Math.round(r.durationMs));
    const pad = (n: number, w: number) => String(n).padStart(w, '0');
    this.envelope('Request', 'RequestData', {
      ver: 2,
      id: randomUUID(),
      name: `${r.method} ${scrub(r.route, 200)}`,
      duration: `00:${pad(Math.floor(ms / 60_000), 2)}:${pad(Math.floor(ms / 1000) % 60, 2)}.${pad(ms % 1000, 3)}`,
      responseCode: String(r.status),
      success: r.status < 500,
    });
  }

  /** Sends what has gathered; a failure drops it (reporting never holds up the application). */
  flush(timeoutMs = SEND_TIMEOUT_MS): Promise<void> {
    if (!this.target || !this.queue.length) return this.flushing ?? Promise.resolve();
    if (this.flushing) return this.flushing;
    const batch = this.queue.splice(0, this.queue.length);
    const url = `${this.target.endpoint}v2/track`;
    const send = this.options?.fetcher ?? fetch;
    this.flushing = send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }
}

/** The one reporter of the process. */
export const telemetry = new Telemetry();
