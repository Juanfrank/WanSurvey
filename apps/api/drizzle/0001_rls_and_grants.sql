-- Tenant isolation, privileges and audit immutability.
-- The application connects as the non-owner role `wansurvey_app` (created by the migrate script),
-- so every query is filtered by row-level security on `app.tenant_id`.

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON tenants, users, projects, memberships, sessions, user_tokens TO wansurvey_app;
--> statement-breakpoint
GRANT DELETE ON memberships, sessions TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_log TO wansurvey_app;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'projects', 'memberships', 'sessions', 'user_tokens', 'audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint
-- Login resolves the tenant from its slug before any tenant context exists.
CREATE OR REPLACE FUNCTION tenant_id_by_slug(p_slug text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT id FROM tenants WHERE slug = lower(p_slug) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tenant_id_by_slug(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenant_id_by_slug(text) TO wansurvey_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
