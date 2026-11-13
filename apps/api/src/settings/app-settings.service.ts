import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Engine } from '../db/engine.js';

export interface StoredSetting {
  value: string;
  updatedAt: Date;
  updatedBy: string | null;
}

/**
 * Settings of the installation as a whole, kept in `app_settings` (mssql/0025). The
 * application reaches them only through the owner procedures `app_setting_get` and `app_setting_set`.
 */
@Injectable()
export class AppSettingsService {
  constructor(@Inject(Engine) private readonly engine: Engine) {}

  async get(key: string): Promise<StoredSetting | null> {
    const res = await sql<{
      value: string | null;
      updated_at: Date;
      updated_by: string | null;
    }>`EXEC app_setting_get ${key}`.execute(this.engine.sql.db);
    const row = res.rows[0];
    if (!row || row.value === null) return null;
    return { value: row.value, updatedAt: new Date(row.updated_at), updatedBy: row.updated_by };
  }

  /** `null` removes the setting, so the deployment's default applies again. */
  async set(key: string, value: string | null, by: string | null): Promise<void> {
    await sql`EXEC app_setting_set ${key}, ${value}, ${by}`.execute(this.engine.sql.db);
  }
}
