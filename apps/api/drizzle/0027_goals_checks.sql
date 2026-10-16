-- Interviewer goals per period, cross-case eligibility checks on the sampling plan, and an
-- index for the hourly expiry of cases held too long after assignment.
CREATE TABLE "interviewer_goals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	"project_id" uuid NOT NULL REFERENCES "projects"("id"),
	"questionnaire_id" uuid REFERENCES "questionnaires"("id"),
	"user_id" uuid NOT NULL REFERENCES "users"("id"),
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"target" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interviewer_goals_period_ck" CHECK ("ends_on" >= "starts_on"),
	CONSTRAINT "interviewer_goals_target_ck" CHECK ("target" > 0)
);
--> statement-breakpoint
CREATE INDEX "interviewer_goals_project_idx" ON "interviewer_goals" USING btree ("tenant_id","project_id","user_id");
--> statement-breakpoint
ALTER TABLE "interviewer_goals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "interviewer_goals" USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON interviewer_goals TO wansurvey_app;
--> statement-breakpoint
ALTER TABLE "sampling_plans" ADD COLUMN "cross_checks" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE INDEX "cases_expiry_idx" ON "cases" USING btree ("project_id","status","assigned_at");
