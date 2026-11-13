/*
  WanSurvey, step 1 of 2: the database and its owner.
  Run it ONCE, before the first start, as a login that may create databases and logins (sysadmin).

  sqlcmd -S <server> -U <admin> -P <password> -b -i 01-create-database.sql ^
         -v DbName="survey_prod" OwnerLogin="survey_owner" OwnerPassword="..."

  Names are yours: the database, the owner, the schema and the two users (the application's and a
  read-only one) are chosen in the settings of the application (see 02-migrate.md); nothing here or
  in the application is tied to a fixed name any more.

  Least privilege, in three roles:
    OWNER   $(OwnerLogin)    owns the database (it is `dbo` in it) and applies the migrations. Used only
                             to deploy; it has no server role, only ALTER SETTINGS, which the migrations
                             need once to turn on contained users. Disable it when not deploying.
    APP     (DATABASE_URL)   the application. A contained user (no server login) without any role: it
                             gets table by table what the migrations GRANT it, always under row-level
                             security, and the application's schema as its default.
    READER  (optional)       reads only the analysis model (schema bi), never the application's tables.
  The APP and READER users are made by the migrations from the URLs you give them, with the
  password in each: you do not make them by hand.

  Passwords: SQL Server's policy asks for 8+ characters from three of four classes, and not the name.
*/
:on error exit
SET NOCOUNT ON;
USE master;
GO

-- The owner: a login, not a member of any server role.
IF SUSER_ID(N'$(OwnerLogin)') IS NULL
  CREATE LOGIN [$(OwnerLogin)] WITH PASSWORD = N'$(OwnerPassword)', CHECK_POLICY = ON, DEFAULT_DATABASE = [master];
GO
-- The migrations turn on contained database authentication (sp_configure + RECONFIGURE).
GRANT ALTER SETTINGS TO [$(OwnerLogin)];
GO

IF DB_ID(N'$(DbName)') IS NULL
  CREATE DATABASE [$(DbName)];
GO
-- The owner of the database is `dbo` in it: the migrations, and the owner procedures that the
-- application runs (EXECUTE AS OWNER), act as dbo, which the row-level security lets through.
ALTER AUTHORIZATION ON DATABASE::[$(DbName)] TO [$(OwnerLogin)];
GO

-- Contained users (the application and the reader have no server login).
EXEC sp_configure 'show advanced options', 1; RECONFIGURE;
EXEC sp_configure 'contained database authentication', 1; RECONFIGURE;
GO
ALTER DATABASE [$(DbName)] SET CONTAINMENT = PARTIAL;
GO
PRINT N'Step 1 done. Now apply the migrations (see 02-migrate.md).';
