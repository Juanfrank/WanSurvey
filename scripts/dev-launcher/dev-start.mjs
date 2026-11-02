#!/usr/bin/env node
// Starts WanSurvey for trying it out: a disposable SQL Server in a Docker container, the database
// (migrations and demo data) and the application, wired together. Run it from the folder of the
// development zip:   node dev-start.mjs   (or start-dev.sh / start-dev.cmd)
//
//   --reset   drops the database and loads the demo data again
//   --down    stops and removes the SQL Server container (its data goes with it) and exits
//   --no-seed leaves the demo data out
//   --help
//
// Settings (environment): DEV_PORT (3000), DEV_DB_PORT (14330), DEV_SQL_IMAGE
// (mcr.microsoft.com/mssql/server:2022-latest), SEED_PASSWORD (demo-password-123).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const flags = process.argv.slice(2);
const CONTAINER = 'wansurvey-dev-mssql';
const IMAGE = process.env.DEV_SQL_IMAGE ?? 'mcr.microsoft.com/mssql/server:2022-latest';
const PORT = Number(process.env.DEV_PORT ?? 3000);
const DB_PORT = Number(process.env.DEV_DB_PORT ?? 14330);
const STATE = join(HERE, '.dev', 'state.json');

if (flags.includes('--help')) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n')
      .slice(1, 12)
      .map((l) => l.replace(/^\/\/ ?/, ''))
      .join('\n'),
  );
  process.exit(0);
}

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const need = (ok, message) => {
  if (!ok) {
    console.error(message);
    process.exit(1);
  }
};

if (flags.includes('--down')) {
  docker('rm', '-f', CONTAINER);
  console.log(`${CONTAINER} removed`);
  process.exit(0);
}

need(
  Number(process.versions.node.split('.')[0]) >= 24,
  `Node 24 or newer is needed (this is ${process.version}).`,
);
need(
  docker('version', '--format', '{{.Server.Version}}').status === 0,
  'Docker is not running (or not installed): it starts the SQL Server for this development copy.\nSee docs/dev-database.md in the repository for using a SQL Server you run yourself instead.',
);

// What stays between runs: the passwords and the encryption key (data encrypted with a key that
// changed could not be read).
mkdirSync(dirname(STATE), { recursive: true });
const state = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, 'utf8'))
  : {
      saPassword: `Ws-${randomBytes(9).toString('base64url')}1!`,
      appPassword: `Ap-${randomBytes(9).toString('base64url')}1!`,
      encryptionKey: randomBytes(32).toString('base64'),
    };
writeFileSync(STATE, JSON.stringify(state, null, 2));

// 1. The SQL Server container.
const inspect = docker('inspect', '-f', '{{.State.Running}}', CONTAINER);
if (inspect.status !== 0) {
  console.log(`Starting SQL Server (${IMAGE}); the first time the image is downloaded...`);
  const run = docker(
    'run',
    '-d',
    '--name',
    CONTAINER,
    '-p',
    `127.0.0.1:${DB_PORT}:1433`,
    '-e',
    'ACCEPT_EULA=Y',
    '-e',
    `MSSQL_SA_PASSWORD=${state.saPassword}`,
    IMAGE,
  );
  need(run.status === 0, `Could not start the container:\n${run.stderr}`);
} else if (inspect.stdout.trim() !== 'true') {
  need(docker('start', CONTAINER).status === 0, `Could not start ${CONTAINER}`);
}

const enc = encodeURIComponent;
const adminUrl = `mssql://sa:${enc(state.saPassword)}@localhost:${DB_PORT}/master?trustServerCertificate=true`;

// 2. Wait until it answers (the package's own client).
const { createMssqlDb } = await import(
  pathToFileURL(join(HERE, 'dist/db/mssql/connection.js')).href
);
const { sql } = await import('kysely');
const ready = async () => {
  const db = createMssqlDb(adminUrl, { max: 1, connectTimeoutMs: 3000 });
  try {
    await sql`SELECT 1 AS ok`.execute(db);
    return true;
  } catch {
    return false;
  } finally {
    await db.destroy().catch(() => undefined);
  }
};
process.stdout.write('Waiting for SQL Server');
const began = Date.now();
while (!(await ready())) {
  need(
    Date.now() - began < 180_000,
    '\nSQL Server did not answer in three minutes. See: docker logs ' + CONTAINER,
  );
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(' ready');

// 3. The database: migrations and demo data (the same code as `db:dev`).
const { devDatabase } = await import(pathToFileURL(join(HERE, 'dist/db/dev-db.js')).href);
const dbFlags = [...flags.filter((f) => f === '--reset' || f === '--no-seed')];
await devDatabase(
  {
    DEV_DB_ADMIN_URL: adminUrl,
    DEV_DB_NAME: 'wansurvey_dev',
    DEV_DB_APP_PASSWORD: state.appPassword,
    SEED_PASSWORD: process.env.SEED_PASSWORD ?? 'demo-password-123',
  },
  dbFlags,
  (m) => (m.includes('DATABASE_URL=') ? undefined : console.log(m)),
);

// 4. The application, with the web app on the same address.
const url = (user, password) =>
  `mssql://${user}:${enc(password)}@localhost:${DB_PORT}/wansurvey_dev?trustServerCertificate=true`;
const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(PORT),
  PUBLIC_URL: `http://localhost:${PORT}`,
  DATABASE_URL: url('wansurvey_app', state.appPassword),
  DATABASE_ADMIN_URL: url('sa', state.saPassword),
  ENCRYPTION_KEY: state.encryptionKey,
  MAILER: 'console',
  EXPORT_STORAGE: 'local',
  DATA_DIR: join(HERE, '.dev', 'files'),
  WEB_DIST: join(HERE, 'public'),
  TRUST_PROXY_HOPS: '0',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
};
console.log(`
WanSurvey: http://localhost:${PORT}
  sign in as project.manager@demo.wansurvey.test (password: ${env.SEED_PASSWORD ?? process.env.SEED_PASSWORD ?? 'demo-password-123'})
  other demo users: owner@, admin@, supervisor@, reviewer@, interviewer@, client.viewer@ demo.wansurvey.test
  Ctrl+C stops the application; the SQL Server keeps running (node dev-start.mjs --down removes it)
`);
const app = spawn(process.execPath, [join(HERE, 'dist/main.js')], {
  cwd: HERE,
  env,
  stdio: 'inherit',
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.kill(sig));
app.on('exit', (code) => process.exit(code ?? 0));
