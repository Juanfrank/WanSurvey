-- A logo per project (shown in the app and on its web surveys), kept apart from the project
-- row so lists do not carry the image; the project keeps when it changed, for caches.
CREATE TABLE "project_logos" (
	"project_id" uuid PRIMARY KEY NOT NULL REFERENCES "projects"("id"),
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	"content_type" text NOT NULL,
	"image" bytea NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_logos" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "project_logos" USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON project_logos TO wansurvey_app;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "logo_updated_at" timestamp with time zone;
