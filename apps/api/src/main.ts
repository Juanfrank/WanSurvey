import { setupRequired } from './setup/setup.js';

// Without DATABASE_URL there is nothing to run yet: the installation wizard gives the scripts and
// the settings (it needs no other setting).
if (setupRequired()) {
  const { startSetup } = await import('./setup/setup-app.js');
  await startSetup();
} else await start();

async function start(): Promise<void> {
  // Loaded only now: some modules read the configuration when they are imported.
  const [{ createApp }, { loadConfig }, { ensureInitialAdmin }, { runMssqlMigrations }] =
    await Promise.all([
      import('./app.js'),
      import('./config.js'),
      import('./db/initial-admin.js'),
      import('./db/mssql/migrate.js'),
    ]);
  const { initObservability } = await import('./observability.js');
  const { VERSION } = await import('./version.js');
  const config = loadConfig();
  initObservability(config);
  // Where nothing else runs them (App Service from a zip), pending migrations are applied before
  // the app starts; it does not start on a failed one, so the health check keeps it out.
  if (config.DATABASE_ADMIN_URL)
    await runMssqlMigrations(config.DATABASE_ADMIN_URL, config.DATABASE_URL, {
      schema: config.DATABASE_SCHEMA,
      manageUsers: config.DATABASE_MANAGE_USERS,
      ...(config.DATABASE_READONLY_URL ? { readonlyUrl: config.DATABASE_READONLY_URL } : {}),
    });
  // A new installation has nobody to create the first organisation: INITIAL_ADMIN_USER does.
  if (config.INITIAL_ADMIN_USER && config.DATABASE_ADMIN_URL) {
    const outcome = await ensureInitialAdmin(
      config.DATABASE_ADMIN_URL,
      config.INITIAL_ADMIN_USER,
      {
        entraTenantId: config.ENTRA_TENANT_ID!,
        clientId: config.ENTRA_CLIENT_ID!,
      },
      config.DATABASE_SCHEMA,
    );
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
  console.log(`WanSurvey ${VERSION} listening on port ${config.PORT}`);
}
