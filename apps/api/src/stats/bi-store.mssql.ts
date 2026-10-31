import { sql } from 'kysely';
import type { MssqlDatabase } from '../db/mssql/database.js';
import { zoneOffsets } from './zoned-day.js';

/** The model's tables, in the order they depend on each other. */
export const BI_TABLES = [
  'preguntas_fuente',
  'dim_pregunta',
  'dim_opcion',
  'dim_fila',
  'fact_envio',
  'fact_respuesta',
  'fact_paradato',
  'plano_respuestas',
] as const;

const DAY = 86_400_000;
/** UTC as the model stores it: `2026-03-08T07:00:00`, no zone suffix. */
const utc = (d: Date) => d.toISOString().slice(0, 19);

/**
 * Keeps the analysis model (schema bi, mssql/0009) up to date, for `bi.service.ts`: the UTC offsets of the projects' zones first (SQL Server's AT TIME ZONE cannot read
 * IANA names), then each table in its own transaction, so readers wait for one table at most.
 * The application may only run the model's procedures; it can read nothing in bi.
 */
export class BiStore {
  /** Works out and saves the offsets of every zone the data uses, a margin around its range. */
  async saveZones(db: MssqlDatabase, now = new Date()): Promise<number> {
    const res = await sql<{ tz: string; desde: Date | null; hasta: Date | null }>`
      EXEC bi.zonas_necesarias`.execute(db.db);
    const zones = res.rows.flatMap((z) => {
      const from = new Date(Math.min(z.desde?.getTime() ?? now.getTime(), now.getTime()) - 2 * DAY);
      const to = new Date(Math.max(z.hasta?.getTime() ?? now.getTime(), now.getTime()) + 2 * DAY);
      try {
        return zoneOffsets(z.tz, from, to).map((o) => ({
          tz: z.tz,
          desde: utc(o.start),
          minutos: o.minutes,
        }));
      } catch {
        // A zone the runtime does not know is read as UTC.
        return [];
      }
    });
    await sql`EXEC bi.guardar_zonas ${JSON.stringify(zones)}`.execute(db.db);
    return zones.length;
  }

  /**
   * Refreshes the model when anything it reads changed since the last time (`force`: regardless).
   * Returns whether it ran.
   */
  async refresh(db: MssqlDatabase, force = false): Promise<boolean> {
    const state = (
      await sql<{ actual: string; ultima: string | null }>`EXEC bi.estado_actual`.execute(db.db)
    ).rows[0]!;
    if (!force && state.actual === state.ultima) return false;
    await this.saveZones(db);
    for (const table of BI_TABLES)
      await db.db.transaction().execute(async (tx) => {
        await sql`EXEC bi.refrescar_vista ${table}`.execute(tx);
      });
    await sql`EXEC bi.marcar_huella ${state.actual}`.execute(db.db);
    return true;
  }
}
