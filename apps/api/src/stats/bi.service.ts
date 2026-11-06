import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config.js';
import { Engine } from '../db/engine.js';
import { BiStore } from './bi-store.mssql.js';
import { JobsService } from '../jobs/jobs.service.js';
import { AppSettingsService } from '../settings/app-settings.service.js';

/** Setting keys (`dbo.app_settings`): minutes between refreshes (`0` never), and the last run. */
export const BI_MINUTES_KEY = 'bi.refreshMinutes';
const LAST_KEY = 'bi.lastRefreshAt';
/** How often the job that honours the setting wakes up; the setting cannot be finer than this. */
export const BI_TICK_CRON = '*/10 * * * *';
/** Choices the setting accepts: never, or every so many minutes (15 minutes to a week). */
export const BI_MIN_MINUTES = 15;
export const BI_MAX_MINUTES = 10_080;

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
    private readonly settings: AppSettingsService,
  ) {}

  onModuleInit() {
    // The cron of the deployment applies until someone sets a frequency in the settings; from then on
    // the setting rules and the cron job stands aside (a forced run, as after an erasure, still runs).
    this.jobs.register('bi.refresh', async (d) => {
      if (d.force !== true && (await this.minutes()) !== undefined) return false;
      return this.refresh(d.force === true);
    });
    this.jobs.register('bi.tick', () => this.tick());
    if (this.config.BI_REFRESH_CRON !== 'off')
      this.jobs.schedule('bi.refresh', { cron: this.config.BI_REFRESH_CRON });
    this.jobs.schedule('bi.tick', { cron: BI_TICK_CRON });
  }

  /** The frequency set in the settings: minutes, `null` for never, `undefined` when none is set. */
  async minutes(): Promise<number | null | undefined> {
    const s = await this.settings.get(BI_MINUTES_KEY);
    if (!s) return undefined;
    const n = Number(s.value);
    return n > 0 ? n : null;
  }

  /** Refreshes when the set frequency has passed since the last refresh. Returns whether it ran. */
  async tick(now = new Date()): Promise<boolean> {
    const every = await this.minutes();
    if (!every) return false;
    const last = await this.settings.get(LAST_KEY);
    // A tick may come a little early; a minute of slack keeps a 15-minute choice from waiting 20.
    if (last && now.getTime() - last.updatedAt.getTime() < every * 60_000 - 60_000) return false;
    const ran = await this.refresh();
    // The moment of the check counts even when nothing had changed, so an idle model is not read every tick.
    await this.settings.set(LAST_KEY, now.toISOString(), null);
    return ran;
  }

  /** When the model was last checked or refreshed under the setting. */
  async lastRun(): Promise<Date | null> {
    return (await this.settings.get(LAST_KEY))?.updatedAt ?? null;
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
