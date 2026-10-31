import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config.js';
import { Engine } from '../db/engine.js';
import { JobsService } from '../jobs/jobs.service.js';
import { CawiService } from './cawi.service.js';

/**
 * Sends invitations and reminders in the background (W5): every few seconds the worker runs
 * the `mail.dispatch` job, which looks for organisations with mail due and sends a batch for
 * each (M1). Tests call `tick` directly.
 */
@Injectable()
export class WaveDispatcher implements OnModuleInit {
  private readonly logger = new Logger('WaveDispatcher');
  private running = false;

  constructor(
    private readonly engine: Engine,
    private readonly cawi: CawiService,
    private readonly jobs: JobsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.jobs.register('mail.dispatch', () => this.tick());
    if (this.config.DISPATCH_INTERVAL_MS)
      this.jobs.schedule('mail.dispatch', { everyMs: this.config.DISPATCH_INTERVAL_MS });
  }

  /** One run: a batch per organisation. Returns how many e-mails went out. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      let due: string[] = [];
      try {
        due = await this.engine.tenantsWithMailDue();
      } catch (e) {
        // The database may be unavailable (or not migrated yet); the next run tries again.
        this.logger.warn(`Dispatch skipped: ${(e as Error).message}`);
      }
      for (const tenantId of due) {
        try {
          sent += await this.cawi.dispatch(tenantId, now);
        } catch (e) {
          this.logger.error(`Dispatch failed for ${tenantId}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
    return sent;
  }
}
