-- Taking the next free case, and releasing the next reserve, read the first rows of an ordered
-- list with UPDLOCK and READPAST. Without an index in that order SQL Server reads (and update-locks)
-- every candidate before it sorts, so the first caller locks them all and the others find none.
-- These filtered indexes serve the order directly: each caller reads, locks and takes one row.
CREATE INDEX cases_pool_idx ON cases (project_id, priority DESC, id)
  INCLUDE (questionnaire_id)
  WHERE status = 'fresh' AND assigned_to IS NULL;
--> statement-breakpoint
CREATE INDEX frame_units_reserve_idx ON frame_units (project_id, release_order, id)
  INCLUDE (questionnaire_id)
  WHERE role = 'reserve' AND released_at IS NULL;
