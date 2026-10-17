import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config.js';
import { Database } from '../db/database.js';
import { JobsService } from '../jobs/jobs.service.js';

/**
 * Keeps the analysis model (schema `bi`, migration 0034) up to date: the worker refreshes its
 * materialised views on `BI_REFRESH_CRON`. The app may only run `bi.refrescar()`, a security
 * definer function; it can read nothing in `bi`, which spans every organisation.
 */
@Injectable()
export class BiService implements OnModuleInit {
  private readonly logger = new Logger('BI');

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly database: Database,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register('bi.refresh', () => this.refresh());
    if (this.config.BI_REFRESH_CRON !== 'off')
      this.jobs.schedule('bi.refresh', { cron: this.config.BI_REFRESH_CRON });
  }

  async refresh(): Promise<void> {
    const started = Date.now();
    await this.database.client`select bi.refrescar()`;
    this.logger.log(`Analysis model refreshed in ${Date.now() - started} ms`);
  }
}
