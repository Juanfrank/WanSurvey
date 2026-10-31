-- Erasure of personal data from the interview history. The history is append-only; the one change
-- allowed is blanking an answer event's values or removing the text of a note, and only through
-- this owner procedure (the application has no privilege to update these tables).
ALTER TRIGGER interview_answer_events_immutable ON dbo.interview_answer_events
  INSTEAD OF UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted) OR ISNULL(CAST(SESSION_CONTEXT(N'erasing') AS int), 0) <> 1
    THROW 50030, 'interview history is append-only', 1;
  UPDATE e SET old_value = NULL, new_value = NULL
  FROM dbo.interview_answer_events e JOIN inserted i ON i.id = e.id;
END;
--> statement-breakpoint
ALTER TRIGGER interview_paradata_immutable ON dbo.interview_paradata
  INSTEAD OF UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted) OR ISNULL(CAST(SESSION_CONTEXT(N'erasing') AS int), 0) <> 1
    THROW 50030, 'interview history is append-only', 1;
  UPDATE p SET payload = i.payload
  FROM dbo.interview_paradata p JOIN inserted i ON i.id = p.id;
END;
--> statement-breakpoint
-- Blanks the values of the given variables (in any roster row) and the text of notes, for one
-- interview of the current organisation. @variables is a JSON array of names.
CREATE PROCEDURE dbo.erase_interview_history @interview uniqueidentifier, @variables nvarchar(max)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @tenant uniqueidentifier = TRY_CAST(SESSION_CONTEXT(N'tenant_id') AS uniqueidentifier);
  IF @tenant IS NULL THROW 50032, 'no organisation in context', 1;
  EXEC sp_set_session_context N'erasing', 1;
  UPDATE e SET old_value = NULL, new_value = NULL
  FROM dbo.interview_answer_events e
  WHERE e.interview_id = @interview AND e.tenant_id = @tenant
    AND (CASE WHEN CHARINDEX(N'.', REVERSE(e.variable)) > 0
              THEN RIGHT(e.variable, CHARINDEX(N'.', REVERSE(e.variable)) - 1)
              ELSE e.variable END)
        IN (SELECT j.[value] COLLATE DATABASE_DEFAULT FROM OPENJSON(@variables) j);
  UPDATE p SET payload = JSON_MODIFY(p.payload, N'$.text', NULL)
  FROM dbo.interview_paradata p
  WHERE p.interview_id = @interview AND p.tenant_id = @tenant AND p.type = N'note_added';
  EXEC sp_set_session_context N'erasing', NULL;
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.erase_interview_history TO wansurvey_app;
--> statement-breakpoint
-- A call with a disposition is history, except for erasure: the note and the masked number of
-- the calls of a case can be cleared through the owner procedure below.
ALTER TRIGGER call_attempts_guard ON dbo.call_attempts
  INSTEAD OF UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted)
    THROW 50031, 'call attempts with a disposition cannot change', 1;
  IF ISNULL(CAST(SESSION_CONTEXT(N'erasing') AS int), 0) = 1
  BEGIN
    UPDATE c SET note = i.note, number_masked = i.number_masked
    FROM dbo.call_attempts c JOIN inserted i ON i.id = c.id;
    RETURN;
  END;
  IF EXISTS (
    SELECT 1 FROM inserted i JOIN dbo.call_attempts c ON c.id = i.id WHERE c.disposition IS NOT NULL
  )
    THROW 50031, 'call attempts with a disposition cannot change', 1;
  UPDATE c SET contact_id = i.contact_id, number_masked = i.number_masked, ended_at = i.ended_at,
    connected_ms = i.connected_ms, wrap_up_ms = i.wrap_up_ms, outcome = i.outcome,
    disposition = i.disposition, callback_at = i.callback_at, note = i.note,
    interview_id = i.interview_id
  FROM dbo.call_attempts c JOIN inserted i ON i.id = c.id;
END;
--> statement-breakpoint
CREATE PROCEDURE dbo.erase_call_notes @case uniqueidentifier
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @tenant uniqueidentifier = TRY_CAST(SESSION_CONTEXT(N'tenant_id') AS uniqueidentifier);
  IF @tenant IS NULL THROW 50032, 'no organisation in context', 1;
  EXEC sp_set_session_context N'erasing', 1;
  UPDATE dbo.call_attempts SET note = NULL, number_masked = NULL
  WHERE case_id = @case AND tenant_id = @tenant;
  EXEC sp_set_session_context N'erasing', NULL;
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.erase_call_notes TO wansurvey_app;
