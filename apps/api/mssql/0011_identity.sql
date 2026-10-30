-- Identity as PostgreSQL has it after drizzle/0002 (multi-organisation accounts), 0003 (global
-- users), 0004 (Entra SSO), 0028 (project logos), 0030 (role permissions), 0038 (login lockout)
-- and 0040 (how a session's second factor was verified). The first T-SQL migrations (0000, 0001)
-- followed the schema as it was before: one organisation per account.
--
-- Accounts are global; an organisation sees a person through its tenant_members row. Sign-in
-- runs before any organisation is known, through owner procedures. The user's own context
-- (SESSION_CONTEXT 'user_id') lets a person change their own account.

-- ─── Organisations ─────────────────────────────────────────────────────────────────────
ALTER TABLE tenants ADD role_permissions nvarchar(max) NOT NULL
  CONSTRAINT tenants_role_permissions_df DEFAULT '{}'
  CONSTRAINT tenants_role_permissions_json CHECK (ISJSON(role_permissions) = 1);
--> statement-breakpoint
-- ─── Members of an organisation ────────────────────────────────────────────────────────
CREATE TABLE tenant_members (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT tmembers_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  user_id uniqueidentifier NOT NULL CONSTRAINT tmembers_user_fk FOREIGN KEY REFERENCES users (id),
  -- invited | active | deactivated
  status nvarchar(32) NOT NULL CONSTRAINT tmembers_status_df DEFAULT 'invited',
  id_code nvarchar(64) NULL,
  phone_extension nvarchar(32) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT tmembers_created_df DEFAULT SYSDATETIMEOFFSET(),
  deactivated_at datetimeoffset(3) NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX tenant_members_uq ON tenant_members (tenant_id, user_id);
--> statement-breakpoint
CREATE INDEX tenant_members_user_idx ON tenant_members (user_id);
--> statement-breakpoint
-- ─── Global accounts ───────────────────────────────────────────────────────────────────
-- Out of the organisation policy first: it is bound to users.tenant_id.
ALTER SECURITY POLICY rls.tenant_isolation
  DROP FILTER PREDICATE ON dbo.users,
  DROP BLOCK PREDICATE ON dbo.users AFTER INSERT,
  DROP BLOCK PREDICATE ON dbo.users AFTER UPDATE,
  DROP FILTER PREDICATE ON dbo.user_tokens,
  DROP BLOCK PREDICATE ON dbo.user_tokens AFTER INSERT,
  DROP BLOCK PREDICATE ON dbo.user_tokens AFTER UPDATE;
--> statement-breakpoint
DROP INDEX users_tenant_email_uq ON users;
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT users_tenant_fk;
--> statement-breakpoint
ALTER TABLE users DROP COLUMN tenant_id, id_code, phone_extension, deactivated_at;
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT users_status_df;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_status_df DEFAULT 'pending' FOR status;
--> statement-breakpoint
ALTER TABLE users ADD
  -- The 30-second step of the last TOTP code accepted: each code works once.
  totp_last_step bigint NULL,
  -- Failed passwords and codes since the last success or lock.
  failed_logins int NOT NULL CONSTRAINT users_failed_df DEFAULT 0,
  locked_until datetimeoffset(3) NULL,
  -- Organisation opened by default at the next sign-in.
  last_tenant_id uniqueidentifier NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX users_email_uq ON users (email);
--> statement-breakpoint
-- Tokens are global (a password reset has no organisation); only hashes are stored.
ALTER TABLE user_tokens ALTER COLUMN tenant_id uniqueidentifier NULL;
--> statement-breakpoint
-- The person themselves, and the people of the organisation in context.
CREATE FUNCTION rls.user_visible(@id uniqueidentifier)
  RETURNS TABLE
  WITH SCHEMABINDING
AS
  RETURN SELECT 1 AS allowed
  WHERE @id = TRY_CAST(SESSION_CONTEXT(N'user_id') AS uniqueidentifier)
     OR USER_NAME() = N'dbo'
     OR EXISTS (SELECT 1 FROM dbo.tenant_members tm
                WHERE tm.user_id = @id
                  AND tm.tenant_id = TRY_CAST(SESSION_CONTEXT(N'tenant_id') AS uniqueidentifier));
--> statement-breakpoint
-- Only the person themselves changes their global fields (password, second factor, name).
CREATE FUNCTION rls.user_self(@id uniqueidentifier)
  RETURNS TABLE
  WITH SCHEMABINDING
AS
  RETURN SELECT 1 AS allowed
  WHERE @id = TRY_CAST(SESSION_CONTEXT(N'user_id') AS uniqueidentifier)
     OR USER_NAME() = N'dbo';
--> statement-breakpoint
CREATE SECURITY POLICY rls.users_isolation
  ADD FILTER PREDICATE rls.user_visible(id) ON dbo.users,
  ADD BLOCK PREDICATE rls.user_self(id) ON dbo.users AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
CREATE SECURITY POLICY rls.tenant_members_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.tenant_members,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.tenant_members AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.tenant_members AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.tenant_members TO wansurvey_app;
--> statement-breakpoint
-- An account can hold one role in several organisations.
DROP INDEX memberships_scope_uq ON memberships;
--> statement-breakpoint
CREATE UNIQUE INDEX memberships_scope_uq ON memberships (tenant_id, user_id, scope_key);
--> statement-breakpoint
-- ─── Sessions: how they were opened and how the second factor was verified ─────────────
ALTER TABLE sessions ADD
  mfa_method nvarchar(16) NULL,
  auth_method nvarchar(16) NOT NULL CONSTRAINT sessions_auth_method_df DEFAULT 'password',
  idp_tenant nvarchar(450) NULL;
--> statement-breakpoint
-- ─── Entra SSO ─────────────────────────────────────────────────────────────────────────
CREATE TABLE tenant_sso (
  tenant_id uniqueidentifier NOT NULL PRIMARY KEY CONSTRAINT tsso_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  provider nvarchar(32) NOT NULL CONSTRAINT tsso_provider_df DEFAULT 'entra',
  entra_tenant_id nvarchar(450) NOT NULL,
  client_id nvarchar(450) NOT NULL,
  client_secret_enc nvarchar(max) NULL,
  enabled bit NOT NULL CONSTRAINT tsso_enabled_df DEFAULT 0,
  enforce_sso bit NOT NULL CONSTRAINT tsso_enforce_df DEFAULT 0,
  -- A JSON array of lower-case domains.
  allowed_domains nvarchar(max) NOT NULL CONSTRAINT tsso_domains_df DEFAULT '[]' CONSTRAINT tsso_domains_json CHECK (ISJSON(allowed_domains) = 1),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT tsso_updated_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
-- Identity links are global, like accounts; they hold no secrets.
CREATE TABLE user_identities (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  user_id uniqueidentifier NOT NULL CONSTRAINT uidentities_user_fk FOREIGN KEY REFERENCES users (id),
  provider nvarchar(32) NOT NULL,
  issuer nvarchar(255) NOT NULL,
  subject nvarchar(255) NOT NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT uidentities_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX user_identities_subject_uq ON user_identities (issuer, subject);
--> statement-breakpoint
CREATE INDEX user_identities_user_idx ON user_identities (user_id);
--> statement-breakpoint
-- ─── Project logos ─────────────────────────────────────────────────────────────────────
ALTER TABLE projects ADD logo_updated_at datetimeoffset(3) NULL;
--> statement-breakpoint
CREATE TABLE project_logos (
  project_id uniqueidentifier NOT NULL PRIMARY KEY CONSTRAINT plogos_project_fk FOREIGN KEY REFERENCES projects (id),
  tenant_id uniqueidentifier NOT NULL CONSTRAINT plogos_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  content_type nvarchar(100) NOT NULL,
  image varbinary(max) NOT NULL,
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT plogos_updated_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE SECURITY POLICY rls.identity_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.tenant_sso,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.tenant_sso AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.tenant_sso AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.project_logos,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.project_logos AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.project_logos AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.tenant_sso TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON dbo.user_identities TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.project_logos TO wansurvey_app;
--> statement-breakpoint
-- ─── Sign-in lookups, before any organisation or user context ──────────────────────────
-- Owner procedures: the owner is not under the security policies.
CREATE PROCEDURE dbo.auth_user_by_email @email nvarchar(450)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT id, password_hash, status, totp_enabled, last_tenant_id FROM dbo.users WHERE email = @email;
END;
--> statement-breakpoint
CREATE PROCEDURE dbo.user_id_by_email @email nvarchar(450)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT id FROM dbo.users WHERE email = @email;
END;
--> statement-breakpoint
-- Organisations the person is an active member of (or every membership).
CREATE PROCEDURE dbo.user_tenants @user_id uniqueidentifier, @include_inactive bit = 0
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT t.id, t.slug, t.name, tm.status AS member_status
  FROM dbo.tenant_members tm JOIN dbo.tenants t ON t.id = tm.tenant_id
  WHERE tm.user_id = @user_id AND (@include_inactive = 1 OR tm.status = 'active')
  ORDER BY t.name;
END;
--> statement-breakpoint
-- Revokes the person's sessions in every organisation (password reset).
CREATE PROCEDURE dbo.revoke_user_sessions @user_id uniqueidentifier
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.sessions SET revoked_at = SYSDATETIMEOFFSET()
  WHERE user_id = @user_id AND revoked_at IS NULL;
  SELECT @@ROWCOUNT AS n;
END;
--> statement-breakpoint
-- Until when the account is locked after failed attempts (no row: it is not).
CREATE PROCEDURE dbo.account_locked_until @user_id uniqueidentifier
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT locked_until AS [until] FROM dbo.users
  WHERE id = @user_id AND locked_until > SYSDATETIMEOFFSET();
END;
--> statement-breakpoint
-- A failed password or code: the count goes up, and at @max the account locks for a while (the
-- count starts again after it). Returns the lock's end, if the account is locked.
CREATE PROCEDURE dbo.account_failed @user_id uniqueidentifier, @max int, @lock_seconds int
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.users SET
    failed_logins = CASE WHEN failed_logins + 1 >= @max THEN 0 ELSE failed_logins + 1 END,
    locked_until = CASE WHEN failed_logins + 1 >= @max
                        THEN DATEADD(second, @lock_seconds, SYSDATETIMEOFFSET()) ELSE locked_until END
  WHERE id = @user_id;
  SELECT CASE WHEN locked_until > SYSDATETIMEOFFSET() THEN locked_until END AS [until]
  FROM dbo.users WHERE id = @user_id;
END;
--> statement-breakpoint
CREATE PROCEDURE dbo.account_succeeded @user_id uniqueidentifier
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.users SET failed_logins = 0, locked_until = NULL
  WHERE id = @user_id AND (failed_logins <> 0 OR locked_until IS NOT NULL);
END;
--> statement-breakpoint
-- Starting a Microsoft sign-in: public settings only, never the secret.
CREATE PROCEDURE dbo.sso_config_by_slug @slug nvarchar(450)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT t.id AS tenant_id, t.slug, s.entra_tenant_id, s.client_id, s.enabled
  FROM dbo.tenants t JOIN dbo.tenant_sso s ON s.tenant_id = t.id
  WHERE t.slug = LOWER(@slug);
END;
--> statement-breakpoint
CREATE PROCEDURE dbo.sso_tenants_for_domain @domain nvarchar(450)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT t.id AS tenant_id, t.slug, s.entra_tenant_id, s.client_id, s.enabled
  FROM dbo.tenants t JOIN dbo.tenant_sso s ON s.tenant_id = t.id
  WHERE s.enabled = 1
    AND EXISTS (SELECT 1 FROM OPENJSON(s.allowed_domains) d WHERE LOWER(d.[value]) = LOWER(@domain));
END;
--> statement-breakpoint
-- Which of the organisations enforce Microsoft sign-in (ids as a JSON array).
CREATE PROCEDURE dbo.sso_enforced_tenants @tenant_ids nvarchar(max)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT s.tenant_id, s.entra_tenant_id
  FROM dbo.tenant_sso s
  WHERE s.enabled = 1 AND s.enforce_sso = 1
    AND s.tenant_id IN (SELECT CAST(j.[value] AS uniqueidentifier) FROM OPENJSON(@tenant_ids) j);
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.auth_user_by_email TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.user_id_by_email TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.user_tenants TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.revoke_user_sessions TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.account_locked_until TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.account_failed TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.account_succeeded TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.sso_config_by_slug TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.sso_tenants_for_domain TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.sso_enforced_tenants TO wansurvey_app;
--> statement-breakpoint
-- The analysis model's people are those of the organisation's member list.
ALTER VIEW bi.dim_persona AS
SELECT u.id AS persona_id, u.name AS persona,
       CAST((SELECT STRING_AGG(t.name, N', ') WITHIN GROUP (ORDER BY t.name)
             FROM dbo.team_members m JOIN dbo.teams t ON t.id = m.team_id
             WHERE m.user_id = u.id AND t.tenant_id = tm.tenant_id) AS nvarchar(max)) AS equipos,
       tm.tenant_id AS organizacion_id
FROM dbo.users u
JOIN dbo.tenant_members tm ON tm.user_id = u.id;
