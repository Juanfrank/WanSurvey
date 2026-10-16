-- Likert points (F2): after the mandatory Likert, up to five follow-up questions with their
-- own answers; the point's version goes up when its questions change.
ALTER TABLE "feedback_points" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "feedback_points" ADD COLUMN "items" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "feedback_points" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD COLUMN "answers" jsonb;
--> statement-breakpoint
-- Points made before had a comment box: it becomes their first follow-up question.
UPDATE "feedback_points" SET "items" = jsonb_build_array(jsonb_build_object(
  'id', 'COMENTARIO', 'type', 'text', 'long', true, 'required', false,
  'text', jsonb_build_object('es', '¿Quiere contarnos algo más?')))
WHERE "ask_comment";
