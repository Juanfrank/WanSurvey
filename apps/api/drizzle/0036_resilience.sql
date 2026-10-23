-- Jobs that survive a lost worker (exports, scanned forms: when the last attempt started and
-- how many there were, so a sweeper retries stuck ones a few times), mail sent one message at
-- a time under a lease, and an index for the dispatcher's "mail due" lookup.
ALTER TABLE "exports" ADD COLUMN "started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "papi_scan_batches" ADD COLUMN "started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "papi_scan_batches" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "lease_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "invitations_mail_due_idx" ON "invitations" ("tenant_id")
  WHERE status = 'queued' OR (status = 'sent' AND completed_at IS NULL);
