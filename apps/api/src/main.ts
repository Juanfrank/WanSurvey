import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ensureInitialAdmin } from './db/initial-admin.js';
import { runMssqlMigrations } from './db/mssql/migrate.js';
import { initObservability } from './observability.js';

const config = loadConfig();
initObservability(config);
// Where nothing else runs them (App Service from a zip), pending migrations are applied before
// the app starts; it does not start on a failed one, so the health check keeps it out.
if (config.DATABASE_ADMIN_URL)
  await runMssqlMigrations(config.DATABASE_ADMIN_URL, config.DATABASE_URL);
// A new installation has nobody to create the first organisation: INITIAL_ADMIN_USER does.
if (config.INITIAL_ADMIN_USER && config.DATABASE_ADMIN_URL) {
  const outcome = await ensureInitialAdmin(config.DATABASE_ADMIN_URL, config.INITIAL_ADMIN_USER, {
    entraTenantId: config.ENTRA_TENANT_ID!,
    clientId: config.ENTRA_CLIENT_ID!,
  });
  if (outcome === 'created')
    console.log(
      `Initial administrator ${config.INITIAL_ADMIN_USER}: organisation and owner created`,
    );
  else if (outcome === 'ignored')
    console.warn(
      'INITIAL_ADMIN_USER is ignored: the installation already has organisations (remove the setting)',
    );
}
const app = await createApp();
await app.listen(config.PORT);
