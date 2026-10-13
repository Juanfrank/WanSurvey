CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"options" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"file_name" text,
	"content_type" text,
	"file" "bytea",
	"size" integer,
	"rows" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_enc" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "share_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "stats_daily" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"mode" text NOT NULL,
	"interviewer_id" uuid,
	"submitted" integer DEFAULT 0 NOT NULL,
	"completes" integer DEFAULT 0 NOT NULL,
	"approved" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"active_ms" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interview_answer_events" ADD COLUMN "received_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stats_daily" ADD CONSTRAINT "stats_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stats_daily" ADD CONSTRAINT "stats_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exports_project_idx" ON "exports" USING btree ("tenant_id","project_id","created_at");--> statement-breakpoint
-- CAWI has no interviewer: one row per project, day and mode all the same.
CREATE UNIQUE INDEX "stats_daily_uq" ON "stats_daily" USING btree ("project_id","day","mode","interviewer_id") NULLS NOT DISTINCT;--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stats_daily', 'exports', 'share_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON stats_daily, exports TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON share_links TO wansurvey_app;
--> statement-breakpoint
-- Nightly jobs work across organisations: which ones exist.
CREATE FUNCTION all_tenant_ids()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT id FROM tenants $$;
--> statement-breakpoint
-- A client's summary link arrives before any tenant context: its organisation, from the token
-- (hashed), when the link is still live.
CREATE FUNCTION share_link_by_hash(p_hash text)
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT id, tenant_id FROM share_links
        WHERE token_hash = p_hash AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) $$;
--> statement-breakpoint
-- Answer events synced before this column existed: received when created.
UPDATE interview_answer_events SET received_at = NULL;
