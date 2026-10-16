-- Quick feedback (F1): one question answered with 3 or 5 faces, by a link per face (e-mails,
-- websites, kiosks), an embedded widget, or small printed slips keyed in the office.
CREATE TABLE "feedback_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	"project_id" uuid NOT NULL REFERENCES "projects"("id"),
	"name" text NOT NULL,
	"question" jsonb NOT NULL,
	"faces" smallint DEFAULT 3 NOT NULL,
	"ask_comment" boolean DEFAULT true NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_points_faces" CHECK ("faces" IN (3, 5))
);
--> statement-breakpoint
CREATE TABLE "feedback_responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	"point_id" uuid NOT NULL REFERENCES "feedback_points"("id"),
	"score" smallint NOT NULL,
	"channel" text DEFAULT 'link' NOT NULL,
	"ref" text,
	"comment" text,
	"edit_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_responses_score" CHECK ("score" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE INDEX "feedback_points_project_idx" ON "feedback_points" USING btree ("tenant_id","project_id");
--> statement-breakpoint
CREATE INDEX "feedback_responses_point_idx" ON "feedback_responses" USING btree ("tenant_id","point_id","created_at");
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['feedback_points', 'feedback_responses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON feedback_points TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON feedback_responses TO wansurvey_app;
--> statement-breakpoint
-- Face links and widgets arrive before any tenant context: they find the organisation from
-- the point's slug, and nothing else.
CREATE FUNCTION feedback_point_by_slug(p_slug text)
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT id, tenant_id FROM feedback_points WHERE slug = p_slug AND active $$;
