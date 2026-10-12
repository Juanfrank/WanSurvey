import { api } from '../api.js';
import type { InterviewStore, LocalInterview } from './store.js';

const BATCH = 500;
const MAX_BACKOFF_MS = 60_000;

export interface SyncResult {
  acks: Record<string, number>;
  errors: Record<string, string>;
  serverTime: string;
}

type Send = (body: unknown, keepalive: boolean) => Promise<SyncResult>;

const defaultSend: Send = (body, keepalive) =>
  api<SyncResult>('/interviews/sync', { method: 'POST', body, keepalive });

/**
 * Sends the outbox to the server. One send at a time; after a failure the next try waits
 * twice as long (up to a minute). Whatever is acknowledged leaves the outbox.
 */
export class Syncer {
  private running: Promise<SyncResult | null> | null = null;
  private failures = 0;
  private nextTry = 0;
  /** Problems the server reported per interview (e.g. NOT_THIS_DEVICE). */
  readonly problems = new Map<string, string>();

  constructor(
    private readonly store: InterviewStore,
    private readonly deviceId: string,
    private readonly send: Send = defaultSend,
    private readonly now: () => number = Date.now,
  ) {}

  /** True while waiting after a failure. */
  get backingOff() {
    return this.now() < this.nextTry;
  }

  /** Sends what is pending for these interviews; `force` ignores the back-off. */
  flush(ids: string[], opts: { force?: boolean; keepalive?: boolean } = {}) {
    if (this.running) return this.running;
    if (!opts.force && this.backingOff) return Promise.resolve(null);
    this.running = this.run(ids, !!opts.keepalive).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(ids: string[], keepalive: boolean): Promise<SyncResult | null> {
    const items: { local: LocalInterview; ops: Awaited<ReturnType<InterviewStore['pending']>> }[] =
      [];
    for (const id of ids) {
      const local = await this.store.get(id);
      if (!local || local.seq <= local.acked) continue;
      items.push({ local, ops: await this.store.pending(id, BATCH) });
    }
    if (!items.length) return null;
    try {
      const res = await this.send(
        {
          deviceId: this.deviceId,
          interviews: items.map(({ local, ops }) => {
            // The snapshot matches the last change: send it only with the whole outbox.
            const all = ops.length && ops[ops.length - 1]!.seq === local.seq;
            return {
              id: local.id,
              ops,
              ...(all
                ? {
                    state: local.state,
                    position: local.position,
                    activeMs: Math.round(local.activeMs),
                    totalMs: Math.round(local.totalMs),
                  }
                : {}),
            };
          }),
        },
        keepalive,
      );
      for (const [id, upto] of Object.entries(res.acks)) await this.store.acknowledge(id, upto);
      for (const id of ids) this.problems.delete(id);
      for (const [id, code] of Object.entries(res.errors)) this.problems.set(id, code);
      this.failures = 0;
      this.nextTry = 0;
      return res;
    } catch (e) {
      this.failures++;
      this.nextTry = this.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.failures - 1));
      throw e;
    }
  }
}
