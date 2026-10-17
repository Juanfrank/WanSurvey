-- What each role may do, per organisation: changes to the default matrix (role -> permissions).
ALTER TABLE "tenants" ADD COLUMN "role_permissions" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
-- Data-entry clerks become interviewers, who now also key paper forms. Where someone already
-- holds another role in the same place, a lone client role gives way; any other role stays.
DELETE FROM "memberships" o
WHERE o."role" = 'client_viewer'
  AND EXISTS (
    SELECT 1 FROM "memberships" d
    WHERE d."role" = 'data_entry' AND d."tenant_id" = o."tenant_id" AND d."user_id" = o."user_id"
      AND d."project_id" IS NOT DISTINCT FROM o."project_id"
  );
--> statement-breakpoint
DELETE FROM "memberships" d
WHERE d."role" = 'data_entry'
  AND EXISTS (
    SELECT 1 FROM "memberships" o
    WHERE o."role" <> 'data_entry' AND o."tenant_id" = d."tenant_id" AND o."user_id" = d."user_id"
      AND o."project_id" IS NOT DISTINCT FROM d."project_id"
  );
--> statement-breakpoint
UPDATE "memberships" SET "role" = 'interviewer' WHERE "role" = 'data_entry';
