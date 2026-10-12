CREATE TABLE "questionnaire_scenarios" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scenario" jsonb NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questionnaire_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"definition" jsonb NOT NULL,
	"compiled" jsonb NOT NULL,
	"hash" text NOT NULL,
	"mapping" jsonb,
	"published_by" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "questionnaires" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"draft" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "questionnaire_scenarios" ADD CONSTRAINT "questionnaire_scenarios_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_scenarios" ADD CONSTRAINT "questionnaire_scenarios_questionnaire_id_questionnaires_id_fk" FOREIGN KEY ("questionnaire_id") REFERENCES "public"."questionnaires"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_versions" ADD CONSTRAINT "questionnaire_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_versions" ADD CONSTRAINT "questionnaire_versions_questionnaire_id_questionnaires_id_fk" FOREIGN KEY ("questionnaire_id") REFERENCES "public"."questionnaires"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaires" ADD CONSTRAINT "questionnaires_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaires" ADD CONSTRAINT "questionnaires_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_scenarios_name_uq" ON "questionnaire_scenarios" USING btree ("questionnaire_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_versions_uq" ON "questionnaire_versions" USING btree ("questionnaire_id","version");--> statement-breakpoint
CREATE INDEX "questionnaires_project_idx" ON "questionnaires" USING btree ("tenant_id","project_id");--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['questionnaires', 'questionnaire_versions', 'questionnaire_scenarios'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON questionnaires, questionnaire_versions TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON questionnaire_scenarios TO wansurvey_app;
--> statement-breakpoint
-- Published versions are immutable: only published → retired may change, nothing is deleted.
CREATE FUNCTION questionnaire_versions_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP <> 'UPDATE' THEN
      RAISE EXCEPTION 'questionnaire versions cannot be deleted';
    END IF;
    IF NEW.definition IS DISTINCT FROM OLD.definition
      OR NEW.compiled IS DISTINCT FROM OLD.compiled
      OR NEW.hash IS DISTINCT FROM OLD.hash
      OR NEW.mapping IS DISTINCT FROM OLD.mapping
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.questionnaire_id IS DISTINCT FROM OLD.questionnaire_id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.published_by IS DISTINCT FROM OLD.published_by THEN
      RAISE EXCEPTION 'published questionnaire versions are immutable';
    END IF;
    IF NOT (OLD.status = 'published' AND NEW.status = 'retired') THEN
      RAISE EXCEPTION 'a version can only go from published to retired';
    END IF;
    RETURN NEW;
  END $$;
--> statement-breakpoint
CREATE TRIGGER questionnaire_versions_immutable BEFORE UPDATE OR DELETE ON questionnaire_versions
  FOR EACH ROW EXECUTE FUNCTION questionnaire_versions_guard();
