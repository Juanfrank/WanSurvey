ALTER TABLE "cases" ADD COLUMN "sample_pii" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "sample_pii_index" text[];--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "anonymised_at" timestamp with time zone;--> statement-breakpoint
-- Search over sealed personal fields by keyed word hashes (H1).
CREATE INDEX "cases_sample_pii_index_gin" ON "cases" USING gin ("sample_pii_index");
--> statement-breakpoint
-- History stays append-only; the one change allowed is erasure: blanking an answer event's
-- values, or removing the text of a note, with nothing else changed.
CREATE OR REPLACE FUNCTION interview_history_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    -- Nested: plpgsql resolves every column named in a condition, even after a false test.
    IF TG_OP = 'UPDATE' THEN
      IF TG_TABLE_NAME = 'interview_answer_events' THEN
        IF to_jsonb(NEW) ->> 'old_value' IS NULL AND to_jsonb(NEW) ->> 'new_value' IS NULL
           AND to_jsonb(NEW) - 'old_value' - 'new_value' = to_jsonb(OLD) - 'old_value' - 'new_value' THEN
          RETURN NEW;
        END IF;
      ELSIF TG_TABLE_NAME = 'interview_paradata' THEN
        IF to_jsonb(NEW) -> 'payload' = (to_jsonb(OLD) -> 'payload') - 'text'
           AND to_jsonb(NEW) - 'payload' = to_jsonb(OLD) - 'payload' THEN
          RETURN NEW;
        END IF;
      END IF;
    END IF;
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
  END $$;
--> statement-breakpoint
-- Answer history and paradata are append-only for the application. Erasing personal data
-- (retention, a data subject's request) is the one exception, and only through this function:
-- it blanks the values of the given variables (in any roster row) and the text of notes, for
-- one interview of the current organisation.
CREATE FUNCTION erase_interview_history(p_interview uuid, p_variables text[])
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public
  AS $$
    UPDATE interview_answer_events SET old_value = NULL, new_value = NULL
     WHERE interview_id = p_interview AND tenant_id = app_current_tenant()
       AND regexp_replace(variable, '^.*\.', '') = ANY (p_variables);
    UPDATE interview_paradata SET payload = payload - 'text'
     WHERE interview_id = p_interview AND tenant_id = app_current_tenant()
       AND type = 'note_added';
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION erase_interview_history(uuid, text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION erase_interview_history(uuid, text[]) TO wansurvey_app;
