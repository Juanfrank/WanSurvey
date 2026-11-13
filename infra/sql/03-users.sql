/*
  WanSurvey, optional: create or update the schema and the two SQL users by hand, with the owner.
  The application and its migrations do the same from DATABASE_URL / DATABASE_READONLY_URL (see
  02-migrate.md); use this script when the DBA wants to make the users and then check them, or to
  change a password or the reader. It can be run as many times as you like: it creates what is
  missing and sets the rest to what it says here. Run it as the OWNER of step 1, in the database.

  sqlcmd -S <server> -U <owner> -P <password> -d <database> -b -i 03-users.sql ^
         -v SchemaName="survey" RwUser="survey_rw" RwPassword="..." ^
            RoUser="survey_ro" RoPassword="..."

  Pass RoUser="none" (and RoPassword="none": sqlcmd wants every variable) for no read-only user: the reader that exists is then left as it is (to
  remove it, use 05-drop-users.sql).

  READ/WRITE user (RwUser): a contained user, no role, no server login. What it may do on the tables
  and procedures (table by table, under row-level security by organisation) is granted by the
  migrations, not here, and is not widened here: before the first migration it can do nothing, and
  the migration run (also this same script again) leaves its grants alone. It cannot create or alter
  anything, nor change the audit log.
  READ-ONLY user (RoUser): SELECT on schema bi (the analysis model) and nothing else; explicit DENY
  of everything in the application's schema and of changes in bi, which a later broad grant to a
  role cannot override.
  Both use the schema as their default, so that the application writes no schema in its queries.

  Passwords: 8+ characters from three of four classes, and not the name. Names: letters, digits and
  underscores. Choose the schema and the user names before the first migration and keep them.
*/
:on error exit
SET NOCOUNT ON;
GO
DECLARE @schema sysname = N'$(SchemaName)', @rw sysname = N'$(RwUser)', @ro sysname = CASE WHEN N'$(RoUser)' = N'none' THEN N'' ELSE N'$(RoUser)' END;
IF @schema = N'' OR @rw = N'' OR @schema LIKE N'%[^A-Za-z0-9_]%' OR @rw LIKE N'%[^A-Za-z0-9_]%'
   OR @ro LIKE N'%[^A-Za-z0-9_]%' OR @schema LIKE N'[0-9]%' OR @rw LIKE N'[0-9]%' OR @ro LIKE N'[0-9]%'
  THROW 50001, 'SchemaName, RwUser and RoUser: letters, digits and underscores, not starting with a digit.', 1;
IF @ro <> N'' AND @ro = @rw THROW 50001, 'The read-only user must not be the read/write user.', 1;
IF (SELECT containment FROM sys.databases WHERE name = DB_NAME()) = 0
  THROW 50001, 'The database is not contained (step 1 turns it on: SET CONTAINMENT = PARTIAL).', 1;
IF USER_NAME() <> N'dbo' THROW 50001, 'Run it as the owner of the database (dbo).', 1;

DECLARE @sql nvarchar(max);
-- The schema (dbo already exists), owned by dbo.
IF SCHEMA_ID(@schema) IS NULL
BEGIN
  SET @sql = N'CREATE SCHEMA ' + QUOTENAME(@schema) + N' AUTHORIZATION dbo';
  EXEC (@sql);
END;

-- The users: created, or their password and default schema set again.
DECLARE @u sysname, @pw nvarchar(128), @i int = 1;
WHILE @i <= 2
BEGIN
  SELECT @u = CASE @i WHEN 1 THEN @rw ELSE @ro END,
         @pw = CASE @i WHEN 1 THEN N'$(RwPassword)' ELSE N'$(RoPassword)' END;
  IF @u <> N''
  BEGIN
    SET @sql = CASE WHEN DATABASE_PRINCIPAL_ID(@u) IS NULL THEN N'CREATE USER ' ELSE N'ALTER USER ' END
      + QUOTENAME(@u) + N' WITH PASSWORD = ' + QUOTENAME(@pw, '''')
      + N', DEFAULT_SCHEMA = ' + QUOTENAME(@schema);
    EXEC (@sql);
  END;
  SET @i += 1;
END;

-- The reader: the analysis model only.
IF @ro <> N''
BEGIN
  IF SCHEMA_ID(N'bi') IS NULL
    PRINT N'Note: schema bi does not exist yet (the migrations make it); run this script again after them.';
  ELSE
  BEGIN
    SET @sql = N'GRANT SELECT ON SCHEMA::bi TO ' + QUOTENAME(@ro) + N';'
      + N' DENY INSERT, UPDATE, DELETE, EXECUTE, ALTER ON SCHEMA::bi TO ' + QUOTENAME(@ro) + N';'
      + N' DENY SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::' + QUOTENAME(@schema)
      + N' TO ' + QUOTENAME(@ro) + N';';
    EXEC (@sql);
  END;
END;
PRINT N'Users ready. Check them with 04-check-permissions.sql.';
GO
