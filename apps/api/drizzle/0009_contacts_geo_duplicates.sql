ALTER TABLE "contacts" ADD COLUMN "lat" double precision;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "lng" double precision;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "geocode_quality" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "geocoded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "contacts_value_idx" ON "contacts" USING btree ("tenant_id","type","value");