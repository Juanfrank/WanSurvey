import { setupRequired } from './setup/setup.js';

/** The configuration is wrong (not the database's state): that stops the process with its message. */
class ConfigError extends Error {}

// The installation wizard runs instead of the application while the database is not set up, and
// starts the application by itself when it is: without DATABASE_URL (it needs no other setting);
// with one that does not work yet and nobody to migrate (no DATABASE_ADMIN_URL); and with an owner
// whose migrations fail (the server cannot be reached, the owner is refused, a migration fails).
async function boot(): Promise<void> {
  if (setupRequired()) {
    const { startSetup } = await import('./setup/setup-app.js');
    await startSetup();
  } else {
    const owner = !!process.env.DATABASE_ADMIN_URL?.trim();
    const { checkOwner, diagnose, ownerFailure } = await import('./setup/diagnose.js');
    const url = process.env.DATABASE_URL!;
    if (owner) {
      // Where nothing else runs the migrations (App Service from a zip), the owner applies them at start.
      const adminUrl = process.env.DATABASE_ADMIN_URL!;
      try {
        await checkOwner(adminUrl);
        await prepare();
        await listen();
      } catch (e) {
        if (e instanceof ConfigError) throw e;
        console.error('The installation is not ready; the wizard runs meanwhile:', message(e));
        const { startSetup } = await import('./setup/setup-app.js');
        let last = '';
        await startSetup(process.env, {
          probe: async () => {
            try {
              await checkOwner(adminUrl);
              await prepare();
            } catch (err) {
              if (err instanceof ConfigError) throw err;
              // Said once per distinct failure, not every ten seconds.
              if (message(err) !== last) console.error('Migrations failed:', (last = message(err)));
              return ownerFailure(err);
            }
            return diagnose(url);
          },
          onReady: listen,
        });
      }
    } else {
      const first = await diagnose(url).catch(() => null);
      if (first?.ready) await listen();
      else {
        const { startSetup } = await import('./setup/setup-app.js');
        await startSetup(process.env, { probe: () => diagnose(url), onReady: listen });
      }
    }
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Loaded only now: some modules read the configuration when they are imported. */
let loaded: Promise<{
  createApp: typeof import('./app.js').createApp;
  loadConfig: typeof import('./config.js').loadConfig;
  ensureInitialAdmin: typeof import('./db/initial-admin.js').ensureInitialAdmin;
  runMssqlMigrations: typeof import('./db/mssql/migrate.js').runMssqlMigrations;
  VERSION: string;
}> | null = null;
function modules() {
  loaded ??= (async () => {
    const [{ createApp }, { loadConfig }, { ensureInitialAdmin }, { runMssqlMigrations }] =
      await Promise.all([
        import('./app.js'),
        import('./config.js'),
        import('./db/initial-admin.js'),
        import('./db/mssql/migrate.js'),
      ]);
    const { VERSION } = await import('./version.js');
    return { createApp, loadConfig, ensureInitialAdmin, runMssqlMigrations, VERSION };
  })();
  return loaded;
}

let observed = false;
let prepared = false;

/** The migrations and the first administrator, with the owner. Repeatable; done once it has worked. */
async function prepare(): Promise<void> {
  if (prepared) return;
  const m = await modules().catch((e: unknown) => {
    throw new ConfigError(message(e));
  });
  let config;
  try {
    config = m.loadConfig();
  } catch (e) {
    throw new ConfigError(message(e));
  }
  if (!observed) {
    observed = true;
    (await import('./observability.js')).initObservability(config);
  }
  if (config.DATABASE_ADMIN_URL)
    await m.runMssqlMigrations(config.DATABASE_ADMIN_URL, config.DATABASE_URL, {
      schema: config.DATABASE_SCHEMA,
      manageUsers: config.DATABASE_MANAGE_USERS,
      ...(config.DATABASE_READONLY_URL ? { readonlyUrl: config.DATABASE_READONLY_URL } : {}),
    });
  // A new installation has nobody to create the first organisation: INITIAL_ADMIN_USER does.
  if (config.INITIAL_ADMIN_USER && config.DATABASE_ADMIN_URL) {
    const outcome = await m.ensureInitialAdmin(
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
  prepared = true;
}

async function listen(): Promise<void> {
  const m = await modules();
  let config;
  try {
    config = m.loadConfig();
  } catch (e) {
    throw new ConfigError(message(e));
  }
  if (!observed) {
    observed = true;
    (await import('./observability.js')).initObservability(config);
  }
  const app = await m.createApp();
  await app.listen(config.PORT);
  console.log(`WanSurvey ${m.VERSION} listening on port ${config.PORT}`);
}

await boot();
