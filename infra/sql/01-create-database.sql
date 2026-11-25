/*
  WanSurvey, step 1 of 2: the database and its owner. (Does the database already exist? Use
  01-existing-database.sql instead: it creates nothing.)
  Run it ONCE, before the first start, as a login that may create databases and logins (sysadmin).

  Plain T-SQL, for any client (SSMS, Azure Data Studio...): connect to `master`, write the three
  values in the DECLARE lines below and run the whole file.

  Names are yours: the database, the owner, the schema and the two users (the application's and a
  read-only one) are chosen in the settings of the application (see 02-migrate.md); nothing here or
  in the application is tied to a fixed name any more.

  Least privilege, in three roles:
    OWNER   @OwnerLogin     owns the database (it is `dbo` in it) and applies the migrations. Used only
                             to deploy; it has no server role, only ALTER SETTINGS, which the migrations
                             need once to turn on contained users. Disable it when not deploying.
    APP     (DATABASE_URL)   the application. A contained user (no server login) without any role: it
                             gets table by table what the migrations GRANT it, always under row-level
                             security, and the application's schema as its default.
    READER  (optional)       reads only the analysis model (the bi_ tables and views), never the application's tables.
  The APP and READER users are made by the migrations from the URLs you give them, with the
  password in each: you do not have to make them by hand. 03-users.sql makes or updates them by
  hand, 04-check-permissions.sql checks them and 05-drop-users.sql removes the reader.

  Passwords: SQL Server's policy asks for 8+ characters from three of four classes, and not the name.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

-- Write these three values:
DECLARE @DbName sysname = N'survey_prod';
DECLARE @OwnerLogin sysname = N'survey_owner';
DECLARE @OwnerPassword nvarchar(128) = N'<<password of the owner>>';

DECLARE @sql nvarchar(max);
IF DB_NAME() <> N'master' THROW 50001, 'Connect to the master database to run this file.', 1;
IF @OwnerPassword LIKE N'<<%' THROW 50001, 'Write the owner password in the DECLARE lines at the top of the file.', 1;
IF @DbName LIKE N'%[^A-Za-z0-9_.-]%' OR @OwnerLogin LIKE N'%[^A-Za-z0-9_]%'
  THROW 50001, 'Names: letters, digits and underscores.', 1;

-- The owner: a login, not a member of any server role.
IF SUSER_ID(@OwnerLogin) IS NULL
BEGIN
  SET @sql = N'CREATE LOGIN ' + QUOTENAME(@OwnerLogin) + N' WITH PASSWORD = ' + QUOTENAME(@OwnerPassword, '''')
    + N', CHECK_POLICY = ON, DEFAULT_DATABASE = [master]';
  EXEC (@sql);
END;
-- The migrations turn on contained database authentication (sp_configure + RECONFIGURE).
SET @sql = N'GRANT ALTER SETTINGS TO ' + QUOTENAME(@OwnerLogin);
EXEC (@sql);

IF DB_ID(@DbName) IS NULL
BEGIN
  SET @sql = N'CREATE DATABASE ' + QUOTENAME(@DbName);
  EXEC (@sql);
END;
-- The owner of the database is `dbo` in it: the migrations, and the owner procedures that the
-- application runs (EXECUTE AS OWNER), act as dbo, which the row-level security lets through.
SET @sql = N'ALTER AUTHORIZATION ON DATABASE::' + QUOTENAME(@DbName) + N' TO ' + QUOTENAME(@OwnerLogin);
EXEC (@sql);

-- Contained users (the application and the reader have no server login).
EXEC sp_configure 'show advanced options', 1; RECONFIGURE;
EXEC sp_configure 'contained database authentication', 1; RECONFIGURE;
SET @sql = N'ALTER DATABASE ' + QUOTENAME(@DbName) + N' SET CONTAINMENT = PARTIAL';
EXEC (@sql);
PRINT N'Step 1 done. Now apply the migrations (see 02-migrate.md).';
