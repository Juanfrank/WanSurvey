/** The installation wizard (key `setup`). */
export const setupEn = {
  title: 'Installation',
  intro:
    'This installation has no database settings yet (DATABASE_URL is not set). Give the names below, never a password: you get two SQL scripts to copy and run, and the settings to put in the environment.',
  alreadyDone: 'This installation is already configured.',
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
    'Run it once as the owner of the database. It makes the schema, the tables and the security policy, in one transaction; it refuses to run twice.',
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
  settingsTitle: '3. Settings to put in the environment',
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
    'Ejecútelo una vez como propietario de la base. Crea el esquema, las tablas y la política de seguridad, en una transacción; se niega a ejecutarse dos veces.',
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
  settingsTitle: '3. Ajustes para el entorno',
  settingsHelp:
    'Reemplace <password> por la contraseña real, guarde los secretos en una bóveda (Key Vault) y reinicie la aplicación. Sale de este asistente cuando DATABASE_URL está definida. DATABASE_ADMIN_URL es solo para migrar: no la ponga en la aplicación en ejecución si usted ejecutó los scripts.',
  lines: '{{n}} líneas',
  error: 'Revise los nombres e intente de nuevo.',
};
