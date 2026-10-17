-- Goals per day, business day, week or month (or once for the period), and for the whole team.
ALTER TABLE "interviewer_goals" ADD COLUMN "frequency" text DEFAULT 'period' NOT NULL;
--> statement-breakpoint
ALTER TABLE "interviewer_goals" ALTER COLUMN "user_id" DROP NOT NULL;
