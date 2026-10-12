ALTER TABLE "cases" ADD COLUMN "checked_out_device" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "checked_out_by" uuid;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "checked_out_at" timestamp with time zone;