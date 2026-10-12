CREATE TABLE "library_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"content" jsonb NOT NULL,
	"languages" text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questionnaire_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"item_id" text,
	"parent_id" uuid,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questionnaire_presence" (
	"tenant_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" text,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questionnaire_presence_questionnaire_id_user_id_pk" PRIMARY KEY("questionnaire_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_comments" ADD CONSTRAINT "questionnaire_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_comments" ADD CONSTRAINT "questionnaire_comments_questionnaire_id_questionnaires_id_fk" FOREIGN KEY ("questionnaire_id") REFERENCES "public"."questionnaires"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_presence" ADD CONSTRAINT "questionnaire_presence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_presence" ADD CONSTRAINT "questionnaire_presence_questionnaire_id_questionnaires_id_fk" FOREIGN KEY ("questionnaire_id") REFERENCES "public"."questionnaires"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_items_tenant_idx" ON "library_items" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "questionnaire_comments_q_idx" ON "questionnaire_comments" USING btree ("questionnaire_id","created_at");--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['questionnaire_comments', 'questionnaire_presence', 'library_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON questionnaire_comments, questionnaire_presence, library_items TO wansurvey_app;
