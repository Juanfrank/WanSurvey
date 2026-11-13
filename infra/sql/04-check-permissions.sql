/*
  WanSurvey, optional: what the two SQL users may do, and whether it is what it should be.
  Read-only: it changes nothing. Run it as the owner, in the database, after the migrations and
  whenever the permissions are in doubt (after a restore, a deployment or a change by a DBA).

  sqlcmd -S <server> -U <owner> -P <password> -d <database> -b -i 04-check-permissions.sql ^
         -v SchemaName="survey" RwUser="survey_rw" RoUser="survey_ro"

  RoUser="none" skips the reader. Prints, for each user, its default schema, roles and
  permissions, then CHECK lines: OK or FAIL (a FAIL ends with an error, exit code 1 with -b).
*/
:on error exit
SET NOCOUNT ON;
GO
DECLARE @schema sysname = N'$(SchemaName)', @rw sysname = N'$(RwUser)', @ro sysname = CASE WHEN N'$(RoUser)' = N'none' THEN N'' ELSE N'$(RoUser)' END;
IF USER_NAME() <> N'dbo' THROW 50001, 'Run it as the owner of the database (dbo).', 1;

PRINT N'== Users ==';
SELECT p.name AS [user], p.type_desc AS [type], p.default_schema_name AS default_schema,
       CASE WHEN p.authentication_type = 2 THEN 'contained (database password)' ELSE p.authentication_type_desc COLLATE DATABASE_DEFAULT END AS authentication,
       ISNULL((SELECT STRING_AGG(r.name COLLATE DATABASE_DEFAULT, ', ') FROM sys.database_role_members m
               JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
               WHERE m.member_principal_id = p.principal_id), N'(no role)' COLLATE DATABASE_DEFAULT) AS roles
FROM sys.database_principals p WHERE p.name IN (@rw, @ro);

PRINT N'== Permissions granted or denied (schema and database level) ==';
SELECT u.name AS [user], dp.state_desc AS [state], dp.permission_name AS permission,
       CASE dp.class WHEN 0 THEN N'database' WHEN 3 THEN N'schema ' + SCHEMA_NAME(dp.major_id) COLLATE DATABASE_DEFAULT
            ELSE dp.class_desc COLLATE DATABASE_DEFAULT END AS [on]
FROM sys.database_permissions dp JOIN sys.database_principals u ON u.principal_id = dp.grantee_principal_id
WHERE u.name IN (@rw, @ro) AND dp.class IN (0, 3)
ORDER BY u.name, [on], dp.permission_name;

PRINT N'== Objects granted to the read/write user, by kind ==';
SELECT o.type_desc AS kind, dp.permission_name AS permission, COUNT(*) AS objects
FROM sys.database_permissions dp
JOIN sys.database_principals u ON u.principal_id = dp.grantee_principal_id
JOIN sys.objects o ON o.object_id = dp.major_id AND dp.class = 1
WHERE u.name = @rw AND dp.state IN ('G', 'W') AND SCHEMA_NAME(o.schema_id) = @schema
GROUP BY o.type_desc, dp.permission_name ORDER BY o.type_desc, dp.permission_name;

PRINT N'== Checks ==';
DECLARE @bad int = 0;
DECLARE @t TABLE (item nvarchar(200), ok bit);
-- Read/write: no role, no schema- or database-level power, no write on the audit log.
INSERT @t SELECT N'rw exists, default schema ' + @schema, CASE WHEN EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @rw AND default_schema_name = @schema) THEN 1 ELSE 0 END;
INSERT @t SELECT N'rw is in no role', CASE WHEN NOT EXISTS (SELECT 1 FROM sys.database_role_members m WHERE m.member_principal_id = DATABASE_PRINCIPAL_ID(@rw)) THEN 1 ELSE 0 END;
INSERT @t SELECT N'rw has nothing on schemas or the database (only table by table)', CASE WHEN NOT EXISTS (SELECT 1 FROM sys.database_permissions dp WHERE dp.grantee_principal_id = DATABASE_PRINCIPAL_ID(@rw) AND dp.class IN (0, 3) AND dp.state IN ('G', 'W') AND dp.permission_name <> 'CONNECT') THEN 1 ELSE 0 END;
DECLARE @audit nvarchar(300) = QUOTENAME(@schema) + N'.audit_log';
IF OBJECT_ID(@audit) IS NOT NULL
BEGIN
  DECLARE @w int, @sql nvarchar(max) = N'EXECUTE AS USER = ' + QUOTENAME(@rw, '''') + N'; SELECT @w = CASE WHEN HAS_PERMS_BY_NAME(@o, ''OBJECT'', ''UPDATE'') = 1 OR HAS_PERMS_BY_NAME(@o, ''OBJECT'', ''DELETE'') = 1 OR HAS_PERMS_BY_NAME(@o, ''OBJECT'', ''ALTER'') = 1 THEN 1 ELSE 0 END; REVERT;';
  EXEC sp_executesql @sql, N'@o nvarchar(300), @w int OUTPUT', @o = @audit, @w = @w OUTPUT;
  INSERT @t SELECT N'rw cannot update, delete or alter the audit log', CASE WHEN @w = 0 THEN 1 ELSE 0 END;
END;
IF @ro <> N''
BEGIN
  INSERT @t SELECT N'ro exists, default schema ' + @schema, CASE WHEN EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @ro AND default_schema_name = @schema) THEN 1 ELSE 0 END;
  INSERT @t SELECT N'ro is in no role', CASE WHEN NOT EXISTS (SELECT 1 FROM sys.database_role_members m WHERE m.member_principal_id = DATABASE_PRINCIPAL_ID(@ro)) THEN 1 ELSE 0 END;
  DECLARE @r nvarchar(max) = N'EXECUTE AS USER = ' + QUOTENAME(@ro, '''') + N';
    SELECT @rb = HAS_PERMS_BY_NAME(N''bi'', ''SCHEMA'', ''SELECT''),
           @rw2 = CASE WHEN HAS_PERMS_BY_NAME(N''bi'', ''SCHEMA'', ''INSERT'') = 1 OR HAS_PERMS_BY_NAME(N''bi'', ''SCHEMA'', ''UPDATE'') = 1 OR HAS_PERMS_BY_NAME(N''bi'', ''SCHEMA'', ''DELETE'') = 1 OR HAS_PERMS_BY_NAME(N''bi'', ''SCHEMA'', ''EXECUTE'') = 1 THEN 1 ELSE 0 END,
           @ra = HAS_PERMS_BY_NAME(@s, ''SCHEMA'', ''SELECT'');
    REVERT;';
  DECLARE @rb int, @rw2 int, @ra int;
  EXEC sp_executesql @r, N'@s sysname, @rb int OUTPUT, @rw2 int OUTPUT, @ra int OUTPUT', @s = @schema, @rb = @rb OUTPUT, @rw2 = @rw2 OUTPUT, @ra = @ra OUTPUT;
  INSERT @t SELECT N'ro can read schema bi', CASE WHEN @rb = 1 THEN 1 ELSE 0 END;
  INSERT @t SELECT N'ro cannot write or execute in schema bi', CASE WHEN @rw2 = 0 THEN 1 ELSE 0 END;
  INSERT @t SELECT N'ro cannot read the application''s schema ' + @schema, CASE WHEN @ra = 0 THEN 1 ELSE 0 END;
END;
SELECT CASE ok WHEN 1 THEN 'OK  ' ELSE 'FAIL' END AS result, item FROM @t;
SELECT @bad = COUNT(*) FROM @t WHERE ok = 0;
IF @bad > 0 THROW 50003, 'Some permission checks failed (see the FAIL lines).', 1;
PRINT N'All permission checks passed.';
GO
