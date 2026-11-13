/*
  WanSurvey, optional: remove a SQL user: to retire the reader, to lock out a user that must not
  connect any more, or to start again with other names. Run as the OWNER, in the database.

  sqlcmd -S <server> -U <owner> -P <password> -d <database> -b -i 05-drop-users.sql ^
         -v User="survey_ro"

  It drops the user and its permissions on the database (contained users have no login to remove).
  Nothing else changes: the schema, the tables and the data stay. To change only a password, run
  03-users.sql again.

  It refuses the READ/WRITE user: that one holds grants on tables and procedures that only the
  migrations give, once, and a user made again would have none. A user with permissions on objects
  is taken for it. To retire it for good, drop it by hand knowing the application stops, and make a
  new database from step 1 if it must come back.
*/
:on error exit
SET NOCOUNT ON;
GO
DECLARE @u sysname = N'$(User)';
IF USER_NAME() <> N'dbo' THROW 50001, 'Run it as the owner of the database (dbo).', 1;
IF @u IN (N'dbo', N'guest', N'sys', N'INFORMATION_SCHEMA') OR @u LIKE N'%[^A-Za-z0-9_]%'
  THROW 50001, 'Not a user of the application.', 1;
IF EXISTS (SELECT 1 FROM sys.database_permissions WHERE grantee_principal_id = DATABASE_PRINCIPAL_ID(@u) AND class = 1 AND state IN ('G', 'W'))
  THROW 50001, 'This user has grants on tables or procedures: it is the read/write user, which is not dropped here.', 1;
IF DATABASE_PRINCIPAL_ID(@u) IS NULL
  PRINT N'No such user: nothing to do.';
ELSE
BEGIN
  DECLARE @sql nvarchar(max) = N'DROP USER ' + QUOTENAME(@u);
  EXEC (@sql);
  PRINT N'User dropped.';
END;
GO
