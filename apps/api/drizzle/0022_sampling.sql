-- Sampling selector (S1): where the units come from, how they are selected, and the cases
-- made from them. Selected units are never deleted or silently replaced: their role (main,
-- reserve, substitute), probability of inclusion and base weight stay with the case.
CREATE TABLE "sampling_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	"project_id" uuid NOT NULL UNIQUE REFERENCES "projects"("id"),
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"design" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"size" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"eligibility" text,
	"exclusions" text,
	"quotas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"substitution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seed" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"result" jsonb,
	"selected_at" timestamp with time zone,
	"selected_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "frame_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
	"project_id" uuid NOT NULL REFERENCES "projects"("id"),
	"external_id" text NOT NULL,
	"source_label" text,
	"sample" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sample_pii" text,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"import_id" uuid,
	"eligible" boolean DEFAULT true NOT NULL,
	"exclusion" text,
	"role" text,
	"release_order" integer,
	"released_at" timestamp with time zone,
	"inclusion_prob" double precision,
	"base_weight" double precision,
	"stratum" text,
	"case_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "frame_units_external_uq" ON "frame_units" USING btree ("project_id","external_id");
--> statement-breakpoint
CREATE INDEX "frame_units_role_idx" ON "frame_units" USING btree ("tenant_id","project_id","role");
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "frame_unit_id" uuid;
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "selection_role" text;
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "substitute_for" uuid;
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "inclusion_prob" double precision;
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "base_weight" double precision;
--> statement-breakpoint
ALTER TABLE "sample_imports" ADD COLUMN "target" text DEFAULT 'cases' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sample_imports" ADD COLUMN "source_label" text;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sampling_plans', 'frame_units'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON sampling_plans TO wansurvey_app;
--> statement-breakpoint
-- Frame units are removed only before anything is selected (replacing a frame).
GRANT SELECT, INSERT, UPDATE, DELETE ON frame_units TO wansurvey_app;
