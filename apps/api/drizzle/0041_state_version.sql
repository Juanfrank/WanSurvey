-- The version of an interview's snapshot and the device that wrote it last: a device whose
-- copy is based on an older version adopts the server's, and a snapshot built on an older
-- version is not written over a newer one.
ALTER TABLE "interviews" ADD COLUMN "state_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "state_device" text;
