-- Scanned machine-readable paper forms: the uploaded PDFs, their pages and the forms found.
CREATE TABLE "papi_scan_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	"project_id" uuid NOT NULL REFERENCES "projects"("id"),
	"uploaded_by" uuid REFERENCES "users"("id"),
	"file_name" text NOT NULL,
	"pdf" bytea,
	"status" text DEFAULT 'queued' NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "papi_scan_batches_project_idx" ON "papi_scan_batches" USING btree ("tenant_id","project_id","created_at");
--> statement-breakpoint
CREATE TABLE "papi_scan_forms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	"project_id" uuid NOT NULL REFERENCES "projects"("id"),
	"batch_id" uuid NOT NULL REFERENCES "papi_scan_batches"("id") ON DELETE CASCADE,
	"case_id" uuid NOT NULL REFERENCES "cases"("id"),
	"questionnaire_version_id" uuid NOT NULL REFERENCES "questionnaire_versions"("id"),
	"lang" text NOT NULL,
	"interview_id" uuid REFERENCES "interviews"("id"),
	"status" text NOT NULL,
	"pages_expected" integer NOT NULL,
	"pages_found" integer[] DEFAULT '{}' NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "papi_scan_forms_batch_idx" ON "papi_scan_forms" USING btree ("batch_id");
--> statement-breakpoint
CREATE INDEX "papi_scan_forms_interview_idx" ON "papi_scan_forms" USING btree ("interview_id");
--> statement-breakpoint
CREATE TABLE "papi_scan_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	"batch_id" uuid NOT NULL REFERENCES "papi_scan_batches"("id") ON DELETE CASCADE,
	"form_id" uuid REFERENCES "papi_scan_forms"("id") ON DELETE SET NULL,
	"page_no" integer NOT NULL,
	"form_page" integer,
	"problem" text,
	"transform" jsonb,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"image" bytea NOT NULL
);
--> statement-breakpoint
CREATE INDEX "papi_scan_pages_batch_idx" ON "papi_scan_pages" USING btree ("batch_id","page_no");
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['papi_scan_batches', 'papi_scan_forms', 'papi_scan_pages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO wansurvey_app', t);
  END LOOP;
END $$;
