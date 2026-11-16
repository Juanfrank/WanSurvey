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
  READ-ONLY user (RoUser): SELECT on the analysis model (the bi_ tables and views of the schema:
  everything lives in the one schema) and nothing else; explicit DENY of SELECT on every other table
  and view, and of INSERT, UPDATE, DELETE, EXECUTE and ALTER on the schema, which a later broad grant
  to a role cannot override. Run it again after a migration adds tables or views.
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

-- The reader: the analysis model (the bi_ objects) only.
IF @ro <> N''
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE schema_id = SCHEMA_ID(@schema) AND name LIKE N'bi[_]%')
    PRINT N'Note: the analysis model does not exist yet (the migrations make it); run this script again after them.';
  ELSE
  BEGIN
    SET @sql = N'DECLARE @grants nvarchar(max) = N''''; '
      + N'SELECT @grants += CASE WHEN o.name LIKE N''bi[_]%'' THEN N''GRANT'' ELSE N''DENY'' END '
      + N'+ N'' SELECT ON '' + QUOTENAME(SCHEMA_NAME(o.schema_id)) + N''.'' + QUOTENAME(o.name) + N'' TO ' + QUOTENAME(@ro) + N';'' + NCHAR(10) '
      + N'FROM sys.objects o WHERE o.schema_id = SCHEMA_ID(N''' + @schema + N''') AND o.type IN (''U'', ''V'') AND o.is_ms_shipped = 0; '
      + N'SET @grants += N''DENY INSERT, UPDATE, DELETE, EXECUTE, ALTER ON SCHEMA::' + QUOTENAME(@schema) + N' TO ' + QUOTENAME(@ro) + N';''; '
      + N'EXEC (@grants);';
    EXEC (@sql);
  END;
END;
PRINT N'Users ready. Check them with 04-check-permissions.sql.';
GO
