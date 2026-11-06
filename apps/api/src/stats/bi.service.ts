import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config.js';
import { Engine } from '../db/engine.js';
import { BiStore } from './bi-store.mssql.js';
import { JobsService } from '../jobs/jobs.service.js';

/**
 * Keeps the analysis model (schema `bi`, migrations 0009 and 0022) up to date: the worker refills
 * its tables on `BI_REFRESH_CRON`. The app may only run the owner procedures of the model
 * (`bi.refrescar_dimensiones`, `bi.refrescar_vista`, `bi.refrescar`); it can read nothing in `bi`,
 * which spans every organisation.
 */
@Injectable()
export class BiService implements OnModuleInit {
  private readonly logger = new Logger('BI');

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly engine: Engine,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register('bi.refresh', (d) => this.refresh(d.force === true));
    if (this.config.BI_REFRESH_CRON !== 'off')
      this.jobs.schedule('bi.refresh', { cron: this.config.BI_REFRESH_CRON });
  }

  /**
   * Refreshes the model when anything it reads changed since the last time (`force` regardless),
   * the dimensions of the hierarchy in one transaction and then one table per transaction, so
   * readers wait for one table at most and a slow refresh never holds the others. Returns whether it ran.
   */
  async refresh(force = false): Promise<boolean> {
    const started = Date.now();
    const ran = await new BiStore().refresh(this.engine.sql, force);
    if (ran) this.logger.log(`Analysis model refreshed in ${Date.now() - started} ms`);
    return ran;
  }
}
