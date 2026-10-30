import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { runMssqlMigrations } from './db/mssql/migrate.js';
import { initObservability } from './observability.js';

const config = loadConfig();
initObservability(config);
// Where nothing else runs them (App Service from a zip), pending migrations are applied before
// the app starts; it does not start on a failed one, so the health check keeps it out.
if (config.DATABASE_ADMIN_URL)
  await (config.DB_ENGINE === 'mssql' ? runMssqlMigrations : runMigrations)(
    config.DATABASE_ADMIN_URL,
    config.DATABASE_URL,
  );
const app = await createApp();
await app.listen(config.PORT);
