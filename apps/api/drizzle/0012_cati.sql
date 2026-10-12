CREATE TABLE "call_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"interviewer_id" uuid NOT NULL,
	"contact_id" uuid,
	"number_masked" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"connected_ms" integer,
	"wrap_up_ms" integer,
	"outcome" text,
	"disposition" text,
	"callback_at" timestamp with time zone,
	"note" text,
	"interview_id" uuid
);
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "next_contact_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "callback_user_id" uuid;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "call_lock_user_id" uuid;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "call_lock_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "entry_pass" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_attempts_case_idx" ON "call_attempts" USING btree ("case_id","started_at");--> statement-breakpoint
CREATE INDEX "call_attempts_interviewer_idx" ON "call_attempts" USING btree ("tenant_id","interviewer_id","started_at");--> statement-breakpoint
CREATE INDEX "cases_next_contact_idx" ON "cases" USING btree ("project_id","next_contact_at");--> statement-breakpoint
ALTER TABLE call_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE call_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON call_attempts USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON call_attempts TO wansurvey_app;
--> statement-breakpoint
-- A call with a disposition is history: it can no longer change or be deleted. (An answered
-- call gets its disposition when its interview is submitted.)
CREATE FUNCTION call_attempts_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' OR OLD.disposition IS NOT NULL THEN
      RAISE EXCEPTION 'call attempts with a disposition cannot change';
    END IF;
    RETURN NEW;
  END $$;
--> statement-breakpoint
CREATE TRIGGER call_attempts_immutable BEFORE UPDATE OR DELETE ON call_attempts
  FOR EACH ROW EXECUTE FUNCTION call_attempts_guard();
