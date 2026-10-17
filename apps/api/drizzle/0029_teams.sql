-- Teams of people in the organisation (field crews, call-centre shifts), each with a leader.
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	"name" text NOT NULL,
	"leader_user_id" uuid REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "teams_name_uq" ON "teams" USING btree ("tenant_id","name");
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id"),
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	CONSTRAINT "team_members_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['teams', 'team_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO wansurvey_app', t);
  END LOOP;
END $$;
