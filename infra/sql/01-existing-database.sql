/*
  WanSurvey, step 1 for a database that ALREADY EXISTS: it creates no database and touches none of
  its contents. Use it instead of 01-create-database.sql. Run it ONCE as a login that may change the
  server settings and the database (sysadmin, or your DBA).

  sqlcmd -S <server> -U <admin> -P <password> -b -i 01-existing-database.sql ^
         -v DbName="my_database" OwnerLogin="survey_owner" OwnerPassword="..."

  What it does:
    1. Turns on contained database authentication in the server, and makes the database "partially
       contained", if they are not already: the application's users are contained users (a password
       in the database, no server login). Nothing else in the database changes.
    2. The OWNER of the migrations. The migrations and the application's owner procedures run as `dbo`,
       the owner of the database, which the row-level security lets through, so the login that migrates
       must be the owner of the database. Two ways:
         OwnerLogin="survey_owner"  makes that login (if it does not exist) and makes it the owner of
                                    the database. This CHANGES the owner of the database: do not use it
                                    if other applications depend on the current one.
         OwnerLogin="keep"          leaves the owner as it is; use that owner's login as
                                    DATABASE_ADMIN_URL. OwnerPassword is not used ("keep" as well).
       The owner needs no server role or permission after this; disable it when not deploying.

  The tables go in their own schema (DATABASE_SCHEMA, for example "survey"), created by the
  migrations or by 03-users.sql; nothing existing is altered. The application's user and the
  read-only one are made as described in 02-migrate.md.
*/
:on error exit
SET NOCOUNT ON;
USE master;
GO
DECLARE @db sysname = N'$(DbName)', @owner sysname = N'$(OwnerLogin)';
IF DB_ID(@db) IS NULL THROW 50001, 'The database does not exist: this script is for one that does (otherwise use 01-create-database.sql).', 1;
IF @owner = N'keep'
BEGIN
  DECLARE @cur sysname = SUSER_SNAME((SELECT owner_sid FROM sys.databases WHERE name = @db));
  PRINT N'The owner of the database stays: ' + ISNULL(@cur, N'(no login)') + N'. Migrate as that login.';
END;
GO
-- Contained users.
IF (SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = 'contained database authentication') = 0
BEGIN
  EXEC sp_configure 'show advanced options', 1; RECONFIGURE;
  EXEC sp_configure 'contained database authentication', 1; RECONFIGURE;
END;
GO
DECLARE @db sysname = N'$(DbName)', @sql nvarchar(max);
IF (SELECT containment FROM sys.databases WHERE name = @db) = 0
BEGIN
  SET @sql = N'ALTER DATABASE ' + QUOTENAME(@db) + N' SET CONTAINMENT = PARTIAL';
  EXEC (@sql);
END;
GO
-- The owner.
DECLARE @db sysname = N'$(DbName)', @owner sysname = N'$(OwnerLogin)', @sql nvarchar(max);
IF @owner <> N'keep'
BEGIN
  IF SUSER_ID(@owner) IS NULL
  BEGIN
    SET @sql = N'CREATE LOGIN ' + QUOTENAME(@owner) + N' WITH PASSWORD = N''$(OwnerPassword)'', CHECK_POLICY = ON, DEFAULT_DATABASE = [master]';
    EXEC (@sql);
  END;
  SET @sql = N'ALTER AUTHORIZATION ON DATABASE::' + QUOTENAME(@db) + N' TO ' + QUOTENAME(@owner);
  EXEC (@sql);
END;
GO
PRINT N'Step 1 done. Now apply the migrations (see 02-migrate.md).';
