-- A questionnaire can be disabled (no new fills in any mode) or completed (closed for good,
-- optionally continued by another questionnaire of the project).
ALTER TABLE "questionnaires" ADD COLUMN "state" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "questionnaires" ADD COLUMN "state_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "questionnaires" ADD COLUMN "successor_id" uuid REFERENCES "questionnaires"("id");
