-- The first tables on SQL Server (T-SQL), the counterpart of drizzle/0000_init.sql:
-- uuid -> uniqueidentifier, text -> nvarchar, jsonb / text[] -> JSON text checked with ISJSON,
-- timestamptz -> datetimeoffset. Columns that are indexed have a bounded length.
CREATE TABLE tenants (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  name nvarchar(450) NOT NULL,
  slug nvarchar(450) NOT NULL,
  plan nvarchar(64) NOT NULL CONSTRAINT tenants_plan_df DEFAULT 'trial',
  settings nvarchar(max) NOT NULL CONSTRAINT tenants_settings_df DEFAULT '{}' CONSTRAINT tenants_settings_json CHECK (ISJSON(settings) = 1),
  branding nvarchar(max) NOT NULL CONSTRAINT tenants_branding_df DEFAULT '{}' CONSTRAINT tenants_branding_json CHECK (ISJSON(branding) = 1),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT tenants_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX tenants_slug_uq ON tenants (slug);
--> statement-breakpoint
CREATE TABLE users (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT users_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  email nvarchar(450) COLLATE Latin1_General_100_CI_AS NOT NULL,
  name nvarchar(450) NOT NULL,
  first_name nvarchar(450) NULL,
  phone nvarchar(64) NULL,
  id_code nvarchar(64) NULL,
  languages nvarchar(max) NOT NULL CONSTRAINT users_languages_df DEFAULT '[]' CONSTRAINT users_languages_json CHECK (ISJSON(languages) = 1),
  phone_extension nvarchar(32) NULL,
  status nvarchar(32) NOT NULL CONSTRAINT users_status_df DEFAULT 'invited',
  password_hash nvarchar(max) NULL,
  totp_secret_enc nvarchar(max) NULL,
  totp_enabled bit NOT NULL CONSTRAINT users_totp_df DEFAULT 0,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT users_created_df DEFAULT SYSDATETIMEOFFSET(),
  deactivated_at datetimeoffset(3) NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX users_tenant_email_uq ON users (tenant_id, email);
--> statement-breakpoint
CREATE TABLE projects (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT projects_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  name nvarchar(450) NOT NULL,
  code nvarchar(450) NOT NULL,
  status nvarchar(32) NOT NULL CONSTRAINT projects_status_df DEFAULT 'draft',
  modes_enabled nvarchar(max) NOT NULL CONSTRAINT projects_modes_df DEFAULT '[]' CONSTRAINT projects_modes_json CHECK (ISJSON(modes_enabled) = 1),
  timezone nvarchar(64) NOT NULL CONSTRAINT projects_tz_df DEFAULT 'UTC',
  languages nvarchar(max) NOT NULL CONSTRAINT projects_languages_df DEFAULT '["en"]' CONSTRAINT projects_languages_json CHECK (ISJSON(languages) = 1),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT projects_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX projects_tenant_code_uq ON projects (tenant_id, code);
--> statement-breakpoint
CREATE TABLE memberships (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT memberships_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  user_id uniqueidentifier NOT NULL CONSTRAINT memberships_user_fk FOREIGN KEY REFERENCES users (id),
  role nvarchar(64) NOT NULL,
  project_id uniqueidentifier NULL CONSTRAINT memberships_project_fk FOREIGN KEY REFERENCES projects (id),
  -- One membership per user and scope; a null project (organisation-wide) counts as one scope.
  scope_key AS ISNULL(project_id, CAST('00000000-0000-0000-0000-000000000000' AS uniqueidentifier)) PERSISTED,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT memberships_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX memberships_user_idx ON memberships (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX memberships_scope_uq ON memberships (user_id, scope_key);
--> statement-breakpoint
CREATE TABLE sessions (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT sessions_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  user_id uniqueidentifier NOT NULL CONSTRAINT sessions_user_fk FOREIGN KEY REFERENCES users (id),
  token_hash nvarchar(450) NOT NULL,
  csrf_token nvarchar(450) NOT NULL,
  mfa_state nvarchar(32) NOT NULL,
  ip nvarchar(64) NULL,
  user_agent nvarchar(max) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT sessions_created_df DEFAULT SYSDATETIMEOFFSET(),
  last_seen_at datetimeoffset(3) NOT NULL CONSTRAINT sessions_seen_df DEFAULT SYSDATETIMEOFFSET(),
  expires_at datetimeoffset(3) NOT NULL,
  revoked_at datetimeoffset(3) NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX sessions_token_uq ON sessions (token_hash);
--> statement-breakpoint
CREATE INDEX sessions_user_idx ON sessions (user_id);
--> statement-breakpoint
CREATE TABLE user_tokens (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT user_tokens_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  user_id uniqueidentifier NOT NULL CONSTRAINT user_tokens_user_fk FOREIGN KEY REFERENCES users (id),
  purpose nvarchar(64) NOT NULL,
  token_hash nvarchar(450) NOT NULL,
  expires_at datetimeoffset(3) NOT NULL,
  used_at datetimeoffset(3) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT user_tokens_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX user_tokens_hash_uq ON user_tokens (token_hash);
--> statement-breakpoint
CREATE TABLE audit_log (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT audit_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  actor_user_id uniqueidentifier NULL,
  action nvarchar(450) NOT NULL,
  target_type nvarchar(64) NULL,
  target_id nvarchar(450) NULL,
  ip nvarchar(64) NULL,
  user_agent nvarchar(max) NULL,
  details nvarchar(max) NOT NULL CONSTRAINT audit_details_df DEFAULT '{}' CONSTRAINT audit_details_json CHECK (ISJSON(details) = 1),
  at datetimeoffset(3) NOT NULL CONSTRAINT audit_at_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX audit_tenant_at_idx ON audit_log (tenant_id, at);
--> statement-breakpoint
CREATE INDEX audit_action_idx ON audit_log (tenant_id, action);
