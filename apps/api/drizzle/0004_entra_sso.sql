CREATE TABLE "tenant_sso" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'entra' NOT NULL,
	"entra_tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"enforce_sso" boolean DEFAULT false NOT NULL,
	"allowed_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auth_method" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idp_tenant" text;--> statement-breakpoint
ALTER TABLE "tenant_sso" ADD CONSTRAINT "tenant_sso_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_subject_uq" ON "user_identities" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
-- Per-organisation Entra settings are tenant data; the client secret is encrypted by the API.
ALTER TABLE tenant_sso ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_sso FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_sso
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON tenant_sso TO wansurvey_app;
--> statement-breakpoint
-- Identity links are global, like accounts; they hold no secrets.
GRANT SELECT, INSERT ON user_identities TO wansurvey_app;
--> statement-breakpoint
-- Starting a Microsoft sign-in happens before any tenant context: public settings only, no secret.
CREATE FUNCTION sso_config_by_slug(p_slug text)
  RETURNS TABLE (tenant_id uuid, slug text, entra_tenant_id text, client_id text, enabled boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT t.id, t.slug, s.entra_tenant_id, s.client_id, s.enabled
    FROM tenants t JOIN tenant_sso s ON s.tenant_id = t.id
    WHERE t.slug = lower(p_slug)
  $$;
--> statement-breakpoint
CREATE FUNCTION sso_tenants_for_domain(p_domain text)
  RETURNS TABLE (tenant_id uuid, slug text, entra_tenant_id text, client_id text, enabled boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT t.id, t.slug, s.entra_tenant_id, s.client_id, s.enabled
    FROM tenants t JOIN tenant_sso s ON s.tenant_id = t.id
    WHERE s.enabled AND lower(p_domain) = ANY (s.allowed_domains)
  $$;
--> statement-breakpoint
-- Which organisations enforce Microsoft sign-in (used by password login, before tenant context).
CREATE FUNCTION sso_enforced_tenants(p_tenant_ids uuid[])
  RETURNS TABLE (tenant_id uuid, entra_tenant_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT tenant_id, entra_tenant_id FROM tenant_sso WHERE enabled AND enforce_sso AND tenant_id = ANY (p_tenant_ids) $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['sso_config_by_slug(text)', 'sso_tenants_for_domain(text)', 'sso_enforced_tenants(uuid[])'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO wansurvey_app', f);
  END LOOP;
END $$;
