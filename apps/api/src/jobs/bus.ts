import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
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

  private readonly logger = new Logger('Bus');

  constructor(private readonly url: string) {
    // Notifications are best effort (dashboards also refresh on their own): publishing never
    // waits for an unreachable Redis, and its errors are logged, never thrown.
    this.pub = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    this.pub.on('error', (e: Error) => this.logger.warn(`Redis (publish): ${e.message}`));
  }

  async publish(channel: string, message: Record<string, unknown>) {
    try {
      if (this.pub.status === 'wait') await this.pub.connect();
      await this.pub.publish(channel, JSON.stringify(message));
    } catch (e) {
      this.logger.warn(`Not published on ${channel}: ${(e as Error).message}`);
    }
  }

  subscribe(channel: string, fn: (message: Record<string, unknown>) => void) {
    if (!this.sub) {
      this.sub = new Redis(this.url);
      this.sub.on('error', (e: Error) => this.logger.warn(`Redis (subscribe): ${e.message}`));
      this.sub.on('message', (ch: string, raw: string) => {
        try {
          void this.local.publish(ch, JSON.parse(raw) as Record<string, unknown>);
        } catch {
          // Not ours.
        }
      });
    }
    const n = this.counts.get(channel) ?? 0;
    if (n === 0) this.sub.subscribe(channel).catch((e: Error) => this.fail('subscribe', e));
    this.counts.set(channel, n + 1);
    const off = this.local.subscribe(channel, fn);
    return () => {
      off();
      const left = (this.counts.get(channel) ?? 1) - 1;
      this.counts.set(channel, left);
      if (left === 0) {
        this.counts.delete(channel);
        this.sub?.unsubscribe(channel).catch((e: Error) => this.fail('unsubscribe', e));
      }
    };
  }

  private fail(what: string, e: Error) {
    this.logger.warn(`Redis ${what} failed: ${e.message}`);
  }

  async close() {
    this.pub.disconnect();
    this.sub?.disconnect();
    await this.local.close();
  }
}

export const projectChannel = (projectId: string) => `project:${projectId}`;
