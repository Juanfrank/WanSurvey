import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { closeThrottleStorage } from '../common/throttle.js';
import { CONFIG, type AppConfig } from '../config.js';
import { PROCESS_ROLE, type ProcessRole } from './role.js';

/** Which part of the system this process is (M1). */
export { PROCESS_ROLE, type ProcessRole };

export type JobHandler = (data: Record<string, unknown>) => Promise<unknown>;

const QUEUE = 'wansurvey';
/**
 * Long, memory-hungry jobs (building exports) have a queue and workers of their own, so a big
 * export never delays e-mail sending or the live figures queued behind it.
 */
const HEAVY_QUEUE = 'wansurvey-heavy';
const HEAVY = new Set(['exports.build', 'papi.scan', 'bi.refresh']);
/** Failed jobs are kept a week (at most 500) to look into, then dropped. */
const KEEP_FAILED = { count: 500, age: 7 * 24 * 3600 };
/** Tries per job, as with BullMQ (`attempts`), and the first wait before trying again. */
const ATTEMPTS = 3;

/** At most `size` tasks at once, the rest wait their turn in order. */
class Lanes {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((go) => this.waiting.push(go));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
/** Longest wait for Redis to take a job. */
const ENQUEUE_TIMEOUT_MS = 3000;

const withTimeout = <T>(ms: number, p: Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Redis did not answer in ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

interface Schedule {
  name: string;
  everyMs?: number;
  cron?: string;
}

/**
 * Background jobs (M1). With `REDIS_URL` the API only enqueues to BullMQ and the worker process
 * runs the jobs and the schedules. Without Redis (development, API tests) jobs run in this
 * process after a short delay, and the schedules run on timers outside tests.
 *
 * A job id makes enqueueing idempotent while the job waits: several submissions on the same
 * day refresh that day's figures once (`delayMs` is the debounce window).
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules: Schedule[] = [];
  private queue: Queue | null = null;
  private heavyQueue: Queue | null = null;
  private readonly workers: Worker[] = [];
  private connection: Redis | null = null;
  private producer: Redis | null = null;
  private readonly intervals = new Set<ReturnType<typeof setInterval>>();
  /** Inline mode: jobs waiting for their delay (by key) and jobs running. */
  private readonly waiting = new Map<string, () => void>();
  private readonly running = new Set<Promise<unknown>>();
  private seq = 0;
  /** Inline mode: what BullMQ's workers bound with Redis, light and heavy jobs apart. */
  private readonly light: Lanes;
  private readonly heavy: Lanes;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PROCESS_ROLE) private readonly role: ProcessRole,
  ) {
    this.light = new Lanes(config.JOB_CONCURRENCY);
    this.heavy = new Lanes(config.HEAVY_JOB_CONCURRENCY);
    if (config.REDIS_URL) {
      // Workers block on Redis and wait for it to come back; producers fail fast instead, so a
      // request never hangs on an unreachable Redis (BullMQ's advice for queues).
      this.connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
      this.producer = new Redis(config.REDIS_URL, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
      });
      for (const c of [this.connection, this.producer])
        c.on('error', (e: Error) => this.logger.warn(`Redis: ${e.message}`));
      this.queue = new Queue(QUEUE, { connection: this.producer });
      this.heavyQueue = new Queue(HEAVY_QUEUE, { connection: this.producer });
    }
  }

  /**
   * Enqueues without ever failing the caller: when Redis is unavailable the job is logged as
   * not queued, and the work is picked up later (the sweeper, the next schedule or the
   * nightly recompute).
   */
  async offer(
    name: string,
    data: Record<string, unknown> = {},
    opts: { jobId?: string; delayMs?: number } = {},
  ): Promise<boolean> {
    try {
      await this.enqueue(name, data, opts);
      return true;
    } catch (e) {
      this.logger.warn(`Job ${name} not queued: ${(e as Error).message}`);
      return false;
    }
  }

  get inline(): boolean {
    return !this.queue;
  }

  register(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  /** A job repeated every `everyMs`, or on a cron pattern (UTC). */
  schedule(name: string, when: { everyMs: number } | { cron: string }): void {
    this.schedules.push({ name, ...when });
  }

  async enqueue(
    name: string,
    data: Record<string, unknown> = {},
    opts: { jobId?: string; delayMs?: number } = {},
  ): Promise<void> {
    if (this.queue) {
      const queue = HEAVY.has(name) ? this.heavyQueue! : this.queue;
      await withTimeout(
        ENQUEUE_TIMEOUT_MS,
        queue.add(name, data, {
          // BullMQ job ids may not contain ':' (it separates Redis keys).
          ...(opts.jobId ? { jobId: `${name}.${opts.jobId}`.replaceAll(':', '_') } : {}),
          delay: opts.delayMs ?? 0,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: KEEP_FAILED,
        }),
      );
      return;
    }
    const key = opts.jobId ? `${name}.${opts.jobId}` : `${name}.${++this.seq}`;
    if (this.waiting.has(key)) return;
    const fire = () => {
      clearTimeout(timer);
      this.waiting.delete(key);
      const run = this.runInline(name, data).finally(() => this.running.delete(run));
      this.running.add(run);
    };
    const timer = setTimeout(fire, opts.delayMs ?? 0);
    this.waiting.set(key, fire);
  }

  /** Runs a job now in this process (inline mode, tests, and the worker). */
  async run(name: string, data: Record<string, unknown>): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No handler for job ${name}`);
    try {
      return await handler(data);
    } catch (e) {
      this.logger.error(`Job ${name} failed: ${(e as Error).message}`);
      if (this.queue) throw e;
      return undefined;
    }
  }

  /**
   * Inline mode (one process, no Redis): as BullMQ would run it, within the concurrency of
   * its kind (one heavy job at a time) and tried up to ATTEMPTS times, waiting longer each
   * time. A job lost to a restart is picked up by the sweeper or the nightly recompute.
   */
  private async runInline(name: string, data: Record<string, unknown>): Promise<unknown> {
    const lanes = HEAVY.has(name) ? this.heavy : this.light;
    for (let attempt = 1; ; attempt++) {
      try {
        return await lanes.run(() => this.attempt(name, data));
      } catch (e) {
        if (attempt >= ATTEMPTS) {
          this.logger.error(`Job ${name} failed for good: ${(e as Error).message}`);
          return undefined;
        }
        this.logger.warn(`Job ${name} will be tried again: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, this.config.JOB_RETRY_MS * 2 ** (attempt - 1)));
      }
    }
  }

  private async attempt(name: string, data: Record<string, unknown>) {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No handler for job ${name}`);
    return handler(data);
  }

  /** Inline mode: runs waiting jobs now and waits until every job has finished. */
  async drain(): Promise<void> {
    while (this.waiting.size || this.running.size) {
      for (const fire of [...this.waiting.values()]) fire();
      await Promise.all([...this.running]);
    }
  }

  async onApplicationBootstrap() {
    if (this.queue) {
      if (this.role !== 'worker') return;
      for (const s of this.schedules)
        await this.queue.upsertJobScheduler(
          s.name,
          s.everyMs ? { every: s.everyMs } : { pattern: s.cron!, tz: 'UTC' },
          { name: s.name, opts: { removeOnComplete: true, removeOnFail: KEEP_FAILED } },
        );
      // Each worker takes at most `concurrency` jobs at a time from its queue (pulling, so
      // extra worker instances share the load); jobs keep within the database pool.
      for (const [queue, concurrency] of [
        [QUEUE, this.config.JOB_CONCURRENCY],
        [HEAVY_QUEUE, this.config.HEAVY_JOB_CONCURRENCY],
      ] as const) {
        const worker = new Worker(queue, (job: Job) => this.run(job.name, job.data), {
          connection: this.connection!.duplicate({ maxRetriesPerRequest: null }),
          concurrency,
        });
        worker.on('failed', (job, err) =>
          this.logger.warn(`Job ${job?.name} attempt ${job?.attemptsMade} failed: ${err.message}`),
        );
        this.workers.push(worker);
        this.logger.log(`Worker listening on queue ${queue} (${concurrency} at a time)`);
      }
      return;
    }
    // Inline: schedules run on timers, except in tests (which call `run` directly).
    if (this.config.NODE_ENV === 'test') return;
    for (const s of this.schedules) {
      if (!s.everyMs) continue; // Nightly jobs need the worker.
      const t = setInterval(() => void this.run(s.name, {}), s.everyMs);
      t.unref();
      this.intervals.add(t);
    }
  }

  async onModuleDestroy() {
    for (const t of this.intervals) clearInterval(t);
    await this.drain();
    await Promise.all(this.workers.map((w) => w.close()));
    await this.queue?.close();
    await this.heavyQueue?.close();
    this.connection?.disconnect();
    this.producer?.disconnect();
    await closeThrottleStorage();
  }
}
