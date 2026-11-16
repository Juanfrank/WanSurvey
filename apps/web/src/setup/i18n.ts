/** The installation wizard (key `setup`). */
export const setupEn = {
  title: 'Installation',
  intro:
    'This installation has no database settings yet (DATABASE_URL is not set). Give the names below, never a password: you get two SQL scripts to copy and run, and the settings to put in the environment.',
  alreadyDone: 'This installation is already configured.',
  notReady:
    'The database settings are set, but the database is not ready yet. The steps below show what is missing; this page checks again by itself and, when everything is ready, the application starts without a restart.',
  progress: 'Where the installation stands',
  checkAgain: 'Check again',
  checking: 'Checking…',
  ready: 'Everything is ready: the application is starting.',
  steps: {
    server: 'The SQL Server answers',
    migrations: 'The owner applies the migrations (DATABASE_ADMIN_URL)',
    login: 'The application’s user can sign in (script 2 makes it)',
    tables: 'The application’s user can read the tables (scripts 1 and 2)',
  },
  state: { ok: 'Done', pending: 'Pending', blocked: 'Waiting for the step before' },
  reasons: {
    unreachable: 'The server cannot be reached: check the address, the port and the firewall.',
    login_failed:
      'The sign-in was refused: the user does not exist yet or the password is not the one in DATABASE_URL.',
    not_visible:
      'The tables cannot be seen: they are not made yet (script 1), or the user lacks permissions (script 2).',
    owner_login_failed:
      'The owner (DATABASE_ADMIN_URL) was refused: check its user, its password and that the database exists.',
    migration_failed: 'A migration failed: the details are in the application’s log.',
    other: 'The database answered with an error.',
  },
  signIn: 'Go to sign in',
  form: 'What your database administrator decided',
  server: 'SQL Server address',
  serverHint: 'For example sql.example.org or myserver.database.windows.net',
  port: 'Port',
  database: 'Database (it must already exist)',
  schema: 'Schema for the tables',
  schemaHint: 'For example survey. Choose it now and keep it: it cannot be changed later.',
  ownerUser: 'Owner of the database (the login that runs script 1 and migrates)',
  appUser: 'Read/write user (the application)',
  readonlyUser: 'Read-only user (optional: reads only the analysis model)',
  usersByDba: 'My database administrator makes the SQL users (script 2 only checks them)',
  generate: 'Get the scripts',
  generating: 'Generating…',
  results: 'Your scripts',
  step1: '1. Create the tables',
  step1Help:
    'Run it once as the owner of the database. It makes the schema and the whole structure (tables, views, procedures and the security policy) as plain CREATE statements, with no history of migrations, in one transaction; it refuses to run twice.',
  step2: '2. Create the users and the permissions',
  step2Help:
    'Run it after script 1, as the owner of the database. It can be run again (to change a password).',
  step2Vars:
    'It asks for the passwords as sqlcmd variables, which you choose when you run it: {{vars}}.',
  step2Dba:
    'The users must already exist with the default schema {{schema}}: the script checks it and says what is missing.',
  runWith: 'Run it with',
  copy: 'Copy',
  copied: 'Copied',
  download: 'Download',
  step3: '3. Apply the newer migrations',
  step3Help:
    'Only because some migrations are newer than the structure of script 1. Run it after script 2, as the owner of the database. It has its own permissions and refuses to run twice. The ones it applies:',
  settingsTitle: '4. Settings to put in the environment',
  settingsHelp:
    'Replace <password> with the real password, keep the secret ones in a vault (Key Vault), and restart the application. It leaves this wizard when DATABASE_URL is set. DATABASE_ADMIN_URL is only for migrating: leave it out of the running application if you ran the scripts yourself.',
  lines: '{{n}} lines',
  error: 'Check the names and try again.',
};

export const setupEs = {
  title: 'Instalación',
  intro:
    'Esta instalación aún no tiene los ajustes de la base de datos (DATABASE_URL no está definida). Indique los nombres de abajo, nunca una contraseña: recibirá dos scripts SQL para copiar y ejecutar, y los ajustes que debe poner en el entorno.',
  alreadyDone: 'Esta instalación ya está configurada.',
  notReady:
    'Los ajustes de la base de datos están definidos, pero la base aún no está lista. Los pasos de abajo muestran qué falta; esta página vuelve a comprobar sola y, cuando todo esté listo, la aplicación arranca sin reiniciar.',
  progress: 'En qué punto está la instalación',
  checkAgain: 'Comprobar de nuevo',
  checking: 'Comprobando…',
  ready: 'Todo está listo: la aplicación está arrancando.',
  steps: {
    server: 'El servidor SQL responde',
    migrations: 'El propietario aplica las migraciones (DATABASE_ADMIN_URL)',
    login: 'El usuario de la aplicación puede ingresar (el script 2 lo crea)',
    tables: 'El usuario de la aplicación puede leer las tablas (scripts 1 y 2)',
  },
  state: { ok: 'Hecho', pending: 'Pendiente', blocked: 'Espera el paso anterior' },
  reasons: {
    unreachable: 'No se puede llegar al servidor: revise la dirección, el puerto y el firewall.',
    login_failed:
      'Se rechazó el ingreso: el usuario aún no existe o la contraseña no es la de DATABASE_URL.',
    not_visible:
      'No se ven las tablas: aún no están creadas (script 1) o al usuario le faltan permisos (script 2).',
    owner_login_failed:
      'Se rechazó al propietario (DATABASE_ADMIN_URL): revise su usuario, su contraseña y que la base exista.',
    migration_failed: 'Falló una migración: el detalle está en el registro de la aplicación.',
    other: 'La base de datos respondió con un error.',
  },
  signIn: 'Ir a ingresar',
  form: 'Lo que decidió su administrador de base de datos',
  server: 'Dirección del servidor SQL',
  serverHint: 'Por ejemplo sql.ejemplo.org o miservidor.database.windows.net',
  port: 'Puerto',
  database: 'Base de datos (debe existir ya)',
  schema: 'Esquema de las tablas',
  schemaHint: 'Por ejemplo survey. Elíjalo ahora y no lo cambie: no se puede cambiar después.',
  ownerUser: 'Propietario de la base (el login que ejecuta el script 1 y migra)',
  appUser: 'Usuario de escritura/lectura (la aplicación)',
  readonlyUser: 'Usuario de solo lectura (opcional: lee solo el modelo de análisis)',
  usersByDba:
    'Mi administrador de base de datos crea los usuarios SQL (el script 2 solo los verifica)',
  generate: 'Obtener los scripts',
  generating: 'Generando…',
  results: 'Sus scripts',
  step1: '1. Crear las tablas',
  step1Help:
    'Ejecútelo una vez como propietario de la base. Crea el esquema y toda la estructura (tablas, vistas, procedimientos y la política de seguridad) con sentencias CREATE simples, sin el historial de migraciones, en una transacción; se niega a ejecutarse dos veces.',
  step2: '2. Crear los usuarios y los permisos',
  step2Help:
    'Ejecútelo después del script 1, como propietario de la base. Se puede ejecutar de nuevo (para cambiar una contraseña).',
  step2Vars:
    'Pide las contraseñas como variables de sqlcmd, que usted elige al ejecutarlo: {{vars}}.',
  step2Dba:
    'Los usuarios deben existir ya con el esquema predeterminado {{schema}}: el script lo verifica y dice qué falta.',
  runWith: 'Ejecútelo con',
  copy: 'Copiar',
  copied: 'Copiado',
  download: 'Descargar',
  step3: '3. Aplicar las migraciones más nuevas',
  step3Help:
    'Solo porque hay migraciones más nuevas que la estructura del script 1. Ejecútelo después del script 2, como propietario de la base. Trae sus propios permisos y se niega a ejecutarse dos veces. Las que aplica:',
  settingsTitle: '4. Ajustes para el entorno',
  settingsHelp:
    'Reemplace <password> por la contraseña real, guarde los secretos en una bóveda (Key Vault) y reinicie la aplicación. Sale de este asistente cuando DATABASE_URL está definida. DATABASE_ADMIN_URL es solo para migrar: no la ponga en la aplicación en ejecución si usted ejecutó los scripts.',
  lines: '{{n}} líneas',
  error: 'Revise los nombres e intente de nuevo.',
};
