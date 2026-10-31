-- An INSTEAD OF trigger also fires for a statement that touches no row (erasing the history of a
-- case that has none). The guards below must let that through: nothing changes, nothing to refuse.
ALTER TRIGGER interview_answer_events_immutable ON dbo.interview_answer_events
  INSTEAD OF UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted) RETURN;
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
  IF NOT EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted) RETURN;
  IF NOT EXISTS (SELECT 1 FROM inserted) OR ISNULL(CAST(SESSION_CONTEXT(N'erasing') AS int), 0) <> 1
    THROW 50030, 'interview history is append-only', 1;
  UPDATE p SET payload = i.payload
  FROM dbo.interview_paradata p JOIN inserted i ON i.id = p.id;
END;
--> statement-breakpoint
ALTER TRIGGER call_attempts_guard ON dbo.call_attempts
  INSTEAD OF UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted) RETURN;
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
