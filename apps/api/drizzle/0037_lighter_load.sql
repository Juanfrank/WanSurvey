-- Lighter load on a small database server.
-- Indexes for the hot per-project reads: stats and goals by submission time, the live
-- dashboard's recent activity and the analysis cache's change check, invitations per project.
CREATE INDEX IF NOT EXISTS "interviews_project_submitted_idx" ON "interviews" ("project_id", "submitted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interviews_project_updated_idx" ON "interviews" ("project_id", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_project_idx" ON "invitations" ("project_id");
--> statement-breakpoint
-- The analysis model is refreshed only when something it reads changed, one view per
-- transaction (the app loops over bi.refrescar_vista), and the security-definer functions
-- look temporary objects up last.
CREATE TABLE IF NOT EXISTS bi.estado (clave text PRIMARY KEY, valor text NOT NULL);
--> statement-breakpoint
-- A fingerprint of everything the model reads: it changes whenever a refresh would.
CREATE OR REPLACE FUNCTION bi.huella() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = bi, public, pg_temp AS $$
  select concat_ws('|',
    (select count(*) || ':' || coalesce(max(updated_at)::text, '') from interviews),
    (select count(*) || ':' || coalesce(max(created_at)::text, '') from feedback_responses),
    (select count(*) from interview_paradata),
    (select count(*) || ':' || coalesce(max(published_at)::text, '') from questionnaire_versions),
    (select count(*) || ':' || coalesce(max(updated_at)::text, '') from feedback_points))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bi.ultima_huella() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = bi, public, pg_temp AS $$
  select valor from bi.estado where clave = 'huella'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bi.marcar_huella(h text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = bi, public, pg_temp AS $$
  insert into bi.estado (clave, valor) values ('huella', h)
  on conflict (clave) do update set valor = excluded.valor
$$;
--> statement-breakpoint
-- One view of the model, by name (only the model's own views).
CREATE OR REPLACE FUNCTION bi.refrescar_vista(v text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = bi, public, pg_temp AS $$
begin
  if v not in ('dim_pregunta', 'dim_opcion', 'dim_fila', 'fact_envio', 'fact_respuesta',
               'fact_paradato', 'plano_respuestas') then
    raise exception 'Not a view of the analysis model: %', v;
  end if;
  if v <> 'plano_respuestas' and (select ispopulated from pg_catalog.pg_matviews
                                  where schemaname = 'bi' and matviewname = v) then
    execute format('refresh materialized view concurrently bi.%I', v);
  else
    execute format('refresh materialized view bi.%I', v);
  end if;
end $$;
--> statement-breakpoint
-- Everything at once, by hand (select bi.refrescar();).
CREATE OR REPLACE FUNCTION bi.refrescar() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = bi, public, pg_temp AS $$
declare v text;
begin
  foreach v in array array['dim_pregunta', 'dim_opcion', 'dim_fila', 'fact_envio',
                           'fact_respuesta', 'fact_paradato', 'plano_respuestas'] loop
    perform bi.refrescar_vista(v);
  end loop;
  perform bi.marcar_huella(bi.huella());
end $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['bi.huella()', 'bi.ultima_huella()', 'bi.marcar_huella(text)',
                           'bi.refrescar_vista(text)', 'bi.refrescar()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO wansurvey_app', f);
  END LOOP;
END $$;
