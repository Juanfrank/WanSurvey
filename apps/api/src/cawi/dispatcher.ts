import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config.js';
import { Database } from '../db/database.js';
import { CawiService } from './cawi.service.js';

/**
 * Sends invitations and reminders in the background (W5): every few seconds it looks for
 * organisations with mail due and sends a batch for each. In-process for now; it moves to the
 * worker with the job queue later. Tests call `tick` directly.
 */
@Injectable()
export class WaveDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('WaveDispatcher');
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly database: Database,
    private readonly cawi: CawiService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    if (this.config.NODE_ENV === 'test' || !this.config.DISPATCH_INTERVAL_MS) return;
    this.timer = setInterval(() => void this.tick(), this.config.DISPATCH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One run: a batch per organisation. Returns how many e-mails went out. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      let due: string[] = [];
      try {
        due = await this.database.tenantsWithMailDue();
      } catch (e) {
        // The database may be unavailable (or not migrated yet); the next run tries again.
        this.logger.warn(`Dispatch skipped: ${(e as Error).message}`);
      }
      for (const tenantId of due) {
        try {
          sent += await this.database.withTenant(tenantId, (tx) =>
            this.cawi.dispatch(tx, tenantId, now),
          );
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
