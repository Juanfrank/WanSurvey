CREATE TABLE "interview_answer_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"seq" integer NOT NULL,
	"variable" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"at" timestamp with time zone NOT NULL,
	"by_user_id" uuid,
	"source" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "interview_devices" (
	"tenant_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_devices_interview_id_device_id_pk" PRIMARY KEY("interview_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "interview_paradata" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"monotonic_ms" double precision,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"case_id" uuid,
	"questionnaire_version_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"interviewer_id" uuid,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"disposition" text,
	"language" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" text,
	"device_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"active_ms" integer DEFAULT 0 NOT NULL,
	"total_ms" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interview_answer_events" ADD CONSTRAINT "interview_answer_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_answer_events" ADD CONSTRAINT "interview_answer_events_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_devices" ADD CONSTRAINT "interview_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_devices" ADD CONSTRAINT "interview_devices_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_paradata" ADD CONSTRAINT "interview_paradata_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_paradata" ADD CONSTRAINT "interview_paradata_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interview_answer_events_uq" ON "interview_answer_events" USING btree ("interview_id","device_id","seq");--> statement-breakpoint
CREATE INDEX "interview_answer_events_at_idx" ON "interview_answer_events" USING btree ("interview_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_paradata_uq" ON "interview_paradata" USING btree ("interview_id","device_id","seq");--> statement-breakpoint
CREATE INDEX "interviews_case_idx" ON "interviews" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "interviews_project_idx" ON "interviews" USING btree ("tenant_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "interviews_one_open_per_case" ON "interviews" USING btree ("case_id") WHERE status = 'in_progress';
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['interviews', 'interview_devices', 'interview_answer_events', 'interview_paradata'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON interviews, interview_devices TO wansurvey_app;
--> statement-breakpoint
-- Answer history and paradata are append-only, like case events.
GRANT SELECT, INSERT ON interview_answer_events, interview_paradata TO wansurvey_app;
--> statement-breakpoint
CREATE FUNCTION interview_history_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
--> statement-breakpoint
CREATE TRIGGER interview_answer_events_no_update BEFORE UPDATE OR DELETE ON interview_answer_events
  FOR EACH ROW EXECUTE FUNCTION interview_history_immutable();
--> statement-breakpoint
CREATE TRIGGER interview_paradata_no_update BEFORE UPDATE OR DELETE ON interview_paradata
  FOR EACH ROW EXECUTE FUNCTION interview_history_immutable();
