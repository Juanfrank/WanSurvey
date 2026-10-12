CREATE TABLE "entry_mismatches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"first_interview_id" uuid NOT NULL,
	"second_interview_id" uuid NOT NULL,
	"variable" text NOT NULL,
	"first_value" jsonb,
	"second_value" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_value" jsonb,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entry_mismatches" ADD CONSTRAINT "entry_mismatches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_mismatches" ADD CONSTRAINT "entry_mismatches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_mismatches" ADD CONSTRAINT "entry_mismatches_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_mismatches_project_idx" ON "entry_mismatches" USING btree ("tenant_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_mismatches_uq" ON "entry_mismatches" USING btree ("second_interview_id","variable");--> statement-breakpoint
ALTER TABLE entry_mismatches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE entry_mismatches FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON entry_mismatches USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON entry_mismatches TO wansurvey_app;
