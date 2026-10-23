import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config.js';
import { Database } from '../db/database.js';
import { JobsService } from '../jobs/jobs.service.js';

/**
 * Keeps the analysis model (schema `bi`, migration 0034) up to date: the worker refreshes its
 * materialised views on `BI_REFRESH_CRON`. The app may only run `bi.refrescar()`, a security
 * definer function; it can read nothing in `bi`, which spans every organisation.
 */
/** The model's materialised views, in the order they depend on each other. */
const VIEWS = [
  'dim_pregunta',
  'dim_opcion',
  'dim_fila',
  'fact_envio',
  'fact_respuesta',
  'fact_paradato',
  'plano_respuestas',
] as const;
/** Longest refresh of one view. */
const VIEW_TIMEOUT_MS = 15 * 60_000;

@Injectable()
export class BiService implements OnModuleInit {
  private readonly logger = new Logger('BI');

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly database: Database,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register('bi.refresh', (d) => this.refresh(d.force === true));
    if (this.config.BI_REFRESH_CRON !== 'off')
      this.jobs.schedule('bi.refresh', { cron: this.config.BI_REFRESH_CRON });
  }

  /**
   * Refreshes the model when anything it reads changed since the last time (`force` regardless),
   * one view per transaction with its own time limit, so readers wait for one view at most and
   * a slow refresh never holds the others. Returns whether it ran.
   */
  async refresh(force = false): Promise<boolean> {
    const started = Date.now();
    const sql = this.database.client;
    const [state] = await sql<{ now: string; last: string | null }[]>`
      select bi.huella() as now, bi.ultima_huella() as last`;
    const now = state!.now;
    if (!force && now === state!.last) return false;
    for (const view of VIEWS)
      await sql.begin(async (tx) => {
        await tx`select set_config('statement_timeout', ${String(VIEW_TIMEOUT_MS)}, true)`;
        await tx`select bi.refrescar_vista(${view})`;
      });
    await sql`select bi.marcar_huella(${now})`;
    this.logger.log(`Analysis model refreshed in ${Date.now() - started} ms`);
    return true;
  }
}
