import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { CONFIG, type AppConfig } from '../config.js';

export type JobHandler = (data: Record<string, unknown>) => Promise<unknown>;

/** Which part of the system this process is (M1). */
export type ProcessRole = 'api' | 'worker';
export const PROCESS_ROLE = Symbol('PROCESS_ROLE');

const QUEUE = 'wansurvey';

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
  private worker: Worker | null = null;
  private connection: Redis | null = null;
  private readonly intervals = new Set<ReturnType<typeof setInterval>>();
  /** Inline mode: jobs waiting for their delay (by key) and jobs running. */
  private readonly waiting = new Map<string, () => void>();
  private readonly running = new Set<Promise<unknown>>();
  private seq = 0;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PROCESS_ROLE) private readonly role: ProcessRole,
  ) {
    if (config.REDIS_URL) {
      this.connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
      this.queue = new Queue(QUEUE, { connection: this.connection });
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
      await this.queue.add(name, data, {
        // BullMQ job ids may not contain ':' (it separates Redis keys).
        ...(opts.jobId ? { jobId: `${name}.${opts.jobId}`.replaceAll(':', '_') } : {}),
        delay: opts.delayMs ?? 0,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: 100,
      });
      return;
    }
    const key = opts.jobId ? `${name}.${opts.jobId}` : `${name}.${++this.seq}`;
    if (this.waiting.has(key)) return;
    const fire = () => {
      clearTimeout(timer);
      this.waiting.delete(key);
      const run = this.run(name, data).finally(() => this.running.delete(run));
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
          { name: s.name, opts: { removeOnComplete: true, removeOnFail: 100 } },
        );
      this.worker = new Worker(QUEUE, (job: Job) => this.run(job.name, job.data), {
        connection: this.connection!.duplicate({ maxRetriesPerRequest: null }),
        concurrency: 4,
      });
      this.worker.on('failed', (job, err) =>
        this.logger.warn(`Job ${job?.name} attempt ${job?.attemptsMade} failed: ${err.message}`),
      );
      this.logger.log(`Worker listening on queue ${QUEUE}`);
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
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }
}
