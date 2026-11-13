/*
  WanSurvey, step 3 of 3: a read-only user for analysis. Run it AFTER the migrations (step 2),
  because the schema `bi` is made by them, as the owner (or any login that may create users).

  sqlcmd -S <server> -U <owner> -P <password> -d <DbName> -b -i 03-create-readonly-user.sql ^
         -v DbName="survey_prod" ReaderUser="survey_reader" ReaderPassword="..."

  What it may read: only the analysis model, schema `bi` (tables filled by the application on a
  schedule; they span every organisation). Nothing of the application's own tables: those are under
  row-level security by organisation and a reader without that context would see nothing anyway.
  The personal questions are marked in bi.dim_pregunta.personal: put views in front of the model for
  people who may not see personal data (see docs/bi.md).
*/
:on error exit
SET NOCOUNT ON;
USE [$(DbName)];
GO
IF SCHEMA_ID(N'bi') IS NULL THROW 50000, N'Schema bi not found: apply the migrations first.', 1;
GO
IF DATABASE_PRINCIPAL_ID(N'$(ReaderUser)') IS NULL
  CREATE USER [$(ReaderUser)] WITH PASSWORD = N'$(ReaderPassword)';
GO
GRANT SELECT ON SCHEMA::bi TO [$(ReaderUser)];
GO
-- Explicit refusals, so that a later broad grant to a role cannot open the application's tables.
DENY INSERT, UPDATE, DELETE, EXECUTE, ALTER ON SCHEMA::bi TO [$(ReaderUser)];
DENY SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::dbo TO [$(ReaderUser)];
GO
PRINT N'Step 3 done: $(ReaderUser) reads schema bi only.';
