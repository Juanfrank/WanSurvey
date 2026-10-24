-- Export pages are read in submission order after (submitted_at, id): with the id in the index
-- each page is a short index range, not a scan and sort of the whole project. It also serves
-- the date ranges of the statistics, as the index it replaces did.
CREATE INDEX IF NOT EXISTS "interviews_project_submitted_id_idx" ON "interviews" ("project_id", "submitted_at", "id");
--> statement-breakpoint
DROP INDEX IF EXISTS "interviews_project_submitted_idx";
