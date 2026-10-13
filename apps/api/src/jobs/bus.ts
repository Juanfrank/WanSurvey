import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';

/**
 * Notifications between processes (M2): the worker (or the API itself) announces that a
 * project's figures changed, and every API process with a live dashboard open reacts.
 */
export interface Bus {
  publish(channel: string, message: Record<string, unknown>): Promise<void>;
  /** Returns the function that stops listening. */
  subscribe(channel: string, fn: (message: Record<string, unknown>) => void): () => void;
  close(): Promise<void>;
}

export const BUS = Symbol('BUS');

/** One process (development and tests). */
export class LocalBus implements Bus {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  async publish(channel: string, message: Record<string, unknown>) {
    this.emitter.emit(channel, message);
  }

  subscribe(channel: string, fn: (message: Record<string, unknown>) => void) {
    this.emitter.on(channel, fn);
    return () => void this.emitter.off(channel, fn);
  }

  async close() {
    this.emitter.removeAllListeners();
  }
}

/** Redis pub/sub: one connection publishes, one listens to the channels anyone here wants. */
export class RedisBus implements Bus {
  private readonly pub: Redis;
  private sub: Redis | null = null;
  private readonly local = new LocalBus();
  private readonly counts = new Map<string, number>();

  constructor(private readonly url: string) {
    this.pub = new Redis(url, { lazyConnect: true });
  }

  async publish(channel: string, message: Record<string, unknown>) {
    await this.pub.publish(channel, JSON.stringify(message));
  }

  subscribe(channel: string, fn: (message: Record<string, unknown>) => void) {
    if (!this.sub) {
      this.sub = new Redis(this.url);
      this.sub.on('message', (ch: string, raw: string) => {
        try {
          void this.local.publish(ch, JSON.parse(raw) as Record<string, unknown>);
        } catch {
          // Not ours.
        }
      });
    }
    const n = this.counts.get(channel) ?? 0;
    if (n === 0) void this.sub.subscribe(channel);
    this.counts.set(channel, n + 1);
    const off = this.local.subscribe(channel, fn);
    return () => {
      off();
      const left = (this.counts.get(channel) ?? 1) - 1;
      this.counts.set(channel, left);
      if (left === 0) {
        this.counts.delete(channel);
        void this.sub?.unsubscribe(channel);
      }
    };
  }

  async close() {
    this.pub.disconnect();
    this.sub?.disconnect();
    await this.local.close();
  }
}

export const projectChannel = (projectId: string) => `project:${projectId}`;
