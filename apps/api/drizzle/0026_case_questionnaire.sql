-- Each questionnaire of a project has its own cases, sampling frame, sampling plan and
-- assignment rules; the project groups questionnaires under one umbrella. A null
-- questionnaire means "any questionnaire of the project" (rows written before this).
ALTER TABLE "cases" ADD COLUMN "questionnaire_id" uuid REFERENCES "questionnaires"("id");--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "frame_units" ADD COLUMN "questionnaire_id" uuid REFERENCES "questionnaires"("id");--> statement-breakpoint
ALTER TABLE "sampling_plans" ADD COLUMN "questionnaire_id" uuid REFERENCES "questionnaires"("id");--> statement-breakpoint
ALTER TABLE "sample_imports" ADD COLUMN "questionnaire_id" uuid REFERENCES "questionnaires"("id");--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "questionnaire_id" uuid REFERENCES "questionnaires"("id");--> statement-breakpoint
-- What exists goes to the project's first questionnaire.
WITH first AS (
  SELECT DISTINCT ON (project_id) project_id, id
  FROM questionnaires ORDER BY project_id, created_at, id
)
UPDATE cases c SET questionnaire_id = f.id FROM first f WHERE f.project_id = c.project_id;--> statement-breakpoint
WITH first AS (
  SELECT DISTINCT ON (project_id) project_id, id
  FROM questionnaires ORDER BY project_id, created_at, id
)
UPDATE frame_units u SET questionnaire_id = f.id FROM first f WHERE f.project_id = u.project_id;--> statement-breakpoint
WITH first AS (
  SELECT DISTINCT ON (project_id) project_id, id
  FROM questionnaires ORDER BY project_id, created_at, id
)
UPDATE sampling_plans p SET questionnaire_id = f.id FROM first f WHERE f.project_id = p.project_id;--> statement-breakpoint
WITH first AS (
  SELECT DISTINCT ON (project_id) project_id, id
  FROM questionnaires ORDER BY project_id, created_at, id
)
UPDATE sample_imports i SET questionnaire_id = f.id FROM first f WHERE f.project_id = i.project_id;--> statement-breakpoint
-- When each held case was assigned: the latest assignment in its history.
UPDATE cases c SET assigned_at = e.at
FROM (
  SELECT DISTINCT ON (case_id) case_id, at FROM case_events
  WHERE type = 'assigned' ORDER BY case_id, at DESC
) e
WHERE e.case_id = c.id AND c.assigned_to IS NOT NULL;--> statement-breakpoint
-- A case's id, a frame unit's id and the plan are unique per questionnaire.
DROP INDEX "cases_external_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "cases_external_uq" ON "cases" ("project_id", "questionnaire_id", "external_id") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE INDEX "cases_questionnaire_idx" ON "cases" ("project_id", "questionnaire_id", "status");--> statement-breakpoint
DROP INDEX "frame_units_external_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "frame_units_external_uq" ON "frame_units" ("project_id", "questionnaire_id", "external_id") NULLS NOT DISTINCT;--> statement-breakpoint
ALTER TABLE "sampling_plans" DROP CONSTRAINT "sampling_plans_project_id_key";--> statement-breakpoint
CREATE UNIQUE INDEX "sampling_plans_questionnaire_uq" ON "sampling_plans" ("project_id", "questionnaire_id") NULLS NOT DISTINCT;
