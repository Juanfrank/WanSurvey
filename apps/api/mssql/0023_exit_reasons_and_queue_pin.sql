-- Early exit and the callbacks' "next in queue".
--
-- interviews.exit_reason / exit_note: why an interview stopped before the end, chosen from the list
-- of the project's settings (`earlyExit`); set when a telephone interview is closed as interrupted.
-- cases.queue_pin_user_id: the caller who made this case the next one to call (the call queue serves
-- it first, even if its callback is not due yet); cleared when the call opens.
ALTER TABLE interviews ADD exit_reason nvarchar(64) NULL, exit_note nvarchar(1000) NULL;
--> statement-breakpoint
ALTER TABLE cases ADD queue_pin_user_id uniqueidentifier NULL;
