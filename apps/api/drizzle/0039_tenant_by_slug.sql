-- An organisation's id by its slug, before any session: the deployment's default organisation
-- for Microsoft sign-in (SSO_DEFAULT_ORG) may have no row in tenant_sso.
CREATE FUNCTION tenant_id_by_slug(p_slug text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT t.id FROM tenants t WHERE t.slug = lower(p_slug) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tenant_id_by_slug(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenant_id_by_slug(text) TO wansurvey_app;
