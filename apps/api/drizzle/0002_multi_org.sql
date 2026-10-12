CREATE TABLE "tenant_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"id_code" text,
	"phone_extension" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "memberships_scope_uq";--> statement-breakpoint
ALTER TABLE "user_tokens" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_members_uq" ON "tenant_members" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "tenant_members_user_idx" ON "tenant_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_scope_uq" ON "memberships" USING btree ("tenant_id","user_id",coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
-- Multi-org accounts, step 1 of 2: copy each user's organisation into tenant_members.
DO $$
BEGIN
  IF EXISTS (SELECT lower(email) FROM users GROUP BY lower(email) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Cannot make e-mail addresses global: the same e-mail exists in more than one organisation. Merge or rename those accounts first.';
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO tenant_members (id, tenant_id, user_id, status, id_code, phone_extension, created_at, deactivated_at)
  SELECT gen_random_uuid(), tenant_id, id, status, id_code, phone_extension, created_at, deactivated_at FROM users;
--> statement-breakpoint
UPDATE users SET last_tenant_id = tenant_id,
  status = CASE status WHEN 'invited' THEN 'pending' ELSE 'active' END;
--> statement-breakpoint
-- The users policy referenced users.tenant_id; it is replaced in 0003.
DROP POLICY tenant_isolation ON users;
--> statement-breakpoint
ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_members
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON tenant_members TO wansurvey_app;
--> statement-breakpoint
-- Tokens are global (password resets have no organisation); only hashes are stored.
DROP POLICY tenant_isolation ON user_tokens;
--> statement-breakpoint
ALTER TABLE user_tokens NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_tokens DISABLE ROW LEVEL SECURITY;
