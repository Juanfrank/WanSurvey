-- Tenant isolation, privileges and audit immutability on SQL Server, the counterpart of
-- drizzle/0001_rls_and_grants.sql. The application connects as the contained user
-- `wansurvey_app` (made by the migrate script) and sets SESSION_CONTEXT 'tenant_id' for each
-- transaction; security policies filter every row on it. No context means no rows.
CREATE SCHEMA rls;
--> statement-breakpoint
-- The owner (dbo: the migrations, seeding, and the procedures below, which run EXECUTE AS OWNER)
-- is not filtered, as the owner is not under row-level security in PostgreSQL either.
CREATE FUNCTION rls.tenant_predicate(@tenant_id uniqueidentifier)
  RETURNS TABLE
  WITH SCHEMABINDING
AS
  RETURN SELECT 1 AS allowed
  WHERE @tenant_id = TRY_CAST(SESSION_CONTEXT(N'tenant_id') AS uniqueidentifier)
     OR USER_NAME() = N'dbo';
--> statement-breakpoint
CREATE SECURITY POLICY rls.tenant_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(id) ON dbo.tenants,
  ADD BLOCK PREDICATE rls.tenant_predicate(id) ON dbo.tenants AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(id) ON dbo.tenants AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.users,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.users AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.users AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.projects,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.projects AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.projects AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.memberships,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.memberships AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.memberships AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sessions,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sessions AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sessions AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.user_tokens,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.user_tokens AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.user_tokens AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.audit_log,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.audit_log AFTER INSERT
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.tenants TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.users TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.projects TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.memberships TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.sessions TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.user_tokens TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON dbo.audit_log TO wansurvey_app;
--> statement-breakpoint
-- Login resolves the tenant from its slug before any tenant context exists.
CREATE PROCEDURE dbo.tenant_id_by_slug @slug nvarchar(450)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT id FROM dbo.tenants WHERE slug = LOWER(@slug);
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.tenant_id_by_slug TO wansurvey_app;
--> statement-breakpoint
-- The audit log is append-only; TRUNCATE needs ALTER, which the application user lacks.
CREATE TRIGGER audit_log_immutable ON dbo.audit_log
  INSTEAD OF UPDATE, DELETE
AS
BEGIN
  THROW 50001, 'audit_log is append-only', 1;
END;
