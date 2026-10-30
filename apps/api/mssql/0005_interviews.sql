-- Interviews on SQL Server, the counterpart of drizzle/0010, 0012, 0016, 0017 and 0041: the
-- interview with its snapshot and review fields, the device acknowledgements, the append-only
-- answer and paradata history, and CATI call attempts. Device ids are bounded at 200 characters so
-- the keys stay under SQL Server's index size limits.
CREATE TABLE interviews (
  -- The id comes from the client, so a device can start one before it is online.
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT interviews_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT interviews_project_fk FOREIGN KEY REFERENCES projects (id),
  case_id uniqueidentifier NULL CONSTRAINT interviews_case_fk FOREIGN KEY REFERENCES cases (id),
  questionnaire_version_id uniqueidentifier NOT NULL CONSTRAINT interviews_version_fk FOREIGN KEY REFERENCES questionnaire_versions (id),
  mode nvarchar(16) NOT NULL,
  interviewer_id uniqueidentifier NULL,
  -- in_progress | submitted | in_review | approved | returned | rejected | broken_off
  status nvarchar(32) NOT NULL CONSTRAINT interviews_status_df DEFAULT 'in_progress',
  disposition nvarchar(64) NULL,
  language nvarchar(32) NOT NULL,
  -- Case data the engine was given at start, reused to verify.
  context nvarchar(max) NOT NULL CONSTRAINT interviews_context_df DEFAULT '{}' CONSTRAINT interviews_context_json CHECK (ISJSON(context) = 1),
  -- The engine's snapshot, restored on resume.
  state nvarchar(max) NOT NULL CONSTRAINT interviews_state_df DEFAULT '{}' CONSTRAINT interviews_state_json CHECK (ISJSON(state) = 1),
  answers nvarchar(max) NOT NULL CONSTRAINT interviews_answers_df DEFAULT '{}' CONSTRAINT interviews_answers_json CHECK (ISJSON(answers) = 1),
  -- Bumped at every write of state; devices send the one their copy is based on.
  state_version int NOT NULL CONSTRAINT interviews_state_version_df DEFAULT 0,
  state_device nvarchar(200) NULL,
  position nvarchar(450) NULL,
  -- The device writing this interview; others are refused until it is handed over.
  device_id nvarchar(200) NOT NULL,
  started_at datetimeoffset(3) NOT NULL CONSTRAINT interviews_started_df DEFAULT SYSDATETIMEOFFSET(),
  ended_at datetimeoffset(3) NULL,
  -- PAPI double entry: 1 for the first keying, 2 for the second.
  entry_pass int NOT NULL CONSTRAINT interviews_entry_pass_df DEFAULT 1,
  active_ms int NOT NULL CONSTRAINT interviews_active_df DEFAULT 0,
  total_ms int NOT NULL CONSTRAINT interviews_total_df DEFAULT 0,
  -- Quality flags computed at each submission.
  flags nvarchar(max) NOT NULL CONSTRAINT interviews_flags_df DEFAULT '{}' CONSTRAINT interviews_flags_json CHECK (ISJSON(flags) = 1),
  sampled bit NOT NULL CONSTRAINT interviews_sampled_df DEFAULT 0,
  submitted_at datetimeoffset(3) NULL,
  submissions int NOT NULL CONSTRAINT interviews_submissions_df DEFAULT 0,
  reviewed_by uniqueidentifier NULL,
  reviewed_at datetimeoffset(3) NULL,
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT interviews_updated_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX interviews_case_idx ON interviews (case_id);
--> statement-breakpoint
CREATE INDEX interviews_project_idx ON interviews (tenant_id, project_id, status);
--> statement-breakpoint
-- One interview open per case (cases without one, such as an open web link, are not constrained).
CREATE UNIQUE INDEX interviews_one_open_per_case ON interviews (case_id)
  WHERE status = 'in_progress' AND case_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE interview_devices (
  tenant_id uniqueidentifier NOT NULL CONSTRAINT idevices_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  interview_id uniqueidentifier NOT NULL CONSTRAINT idevices_interview_fk FOREIGN KEY REFERENCES interviews (id),
  device_id nvarchar(200) NOT NULL,
  last_seq int NOT NULL CONSTRAINT idevices_seq_df DEFAULT 0,
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT idevices_updated_df DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT interview_devices_pk PRIMARY KEY (interview_id, device_id)
);
--> statement-breakpoint
CREATE TABLE interview_answer_events (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT iaevents_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  interview_id uniqueidentifier NOT NULL CONSTRAINT iaevents_interview_fk FOREIGN KEY REFERENCES interviews (id),
  device_id nvarchar(200) NOT NULL,
  seq int NOT NULL,
  variable nvarchar(450) NOT NULL,
  -- JSON values (a string, a number, a list…); not checked with ISJSON, which refuses plain scalars.
  old_value nvarchar(max) NULL,
  new_value nvarchar(max) NULL,
  at datetimeoffset(3) NOT NULL,
  by_user_id uniqueidentifier NULL,
  -- When the server received it (the device's time is `at`): sync latency.
  received_at datetimeoffset(3) NULL CONSTRAINT iaevents_received_df DEFAULT SYSDATETIMEOFFSET(),
  -- interviewer | respondent | reviewer | system
  source nvarchar(32) NOT NULL,
  -- Why the engine changed it (path_change, prefill…); null for a typed answer.
  reason nvarchar(450) NULL
);
--> statement-breakpoint
-- A change number sent again is ignored (PostgreSQL's ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX interview_answer_events_uq ON interview_answer_events (interview_id, device_id, seq)
  WITH (IGNORE_DUP_KEY = ON);
--> statement-breakpoint
CREATE INDEX interview_answer_events_at_idx ON interview_answer_events (interview_id, at);
--> statement-breakpoint
CREATE TABLE interview_paradata (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT iparadata_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  interview_id uniqueidentifier NOT NULL CONSTRAINT iparadata_interview_fk FOREIGN KEY REFERENCES interviews (id),
  device_id nvarchar(200) NOT NULL,
  seq int NOT NULL,
  type nvarchar(64) NOT NULL,
  at datetimeoffset(3) NOT NULL,
  monotonic_ms float NULL,
  payload nvarchar(max) NOT NULL CONSTRAINT iparadata_payload_df DEFAULT '{}'
);
--> statement-breakpoint
CREATE UNIQUE INDEX interview_paradata_uq ON interview_paradata (interview_id, device_id, seq)
  WITH (IGNORE_DUP_KEY = ON);
--> statement-breakpoint
CREATE TABLE call_attempts (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT cattempts_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT cattempts_project_fk FOREIGN KEY REFERENCES projects (id),
  case_id uniqueidentifier NOT NULL CONSTRAINT cattempts_case_fk FOREIGN KEY REFERENCES cases (id),
  interviewer_id uniqueidentifier NOT NULL,
  contact_id uniqueidentifier NULL,
  -- Last digits only, so the history never repeats the number.
  number_masked nvarchar(64) NULL,
  started_at datetimeoffset(3) NOT NULL CONSTRAINT cattempts_started_df DEFAULT SYSDATETIMEOFFSET(),
  ended_at datetimeoffset(3) NULL,
  connected_ms int NULL,
  wrap_up_ms int NULL,
  -- answered | no_answer | busy | voicemail | wrong_number | disconnected | refusal | callback | appointment; null while dialling
  outcome nvarchar(32) NULL,
  disposition nvarchar(64) NULL,
  callback_at datetimeoffset(3) NULL,
  note nvarchar(max) NULL,
  interview_id uniqueidentifier NULL
);
--> statement-breakpoint
CREATE INDEX call_attempts_case_idx ON call_attempts (case_id, started_at);
--> statement-breakpoint
CREATE INDEX call_attempts_interviewer_idx ON call_attempts (tenant_id, interviewer_id, started_at);
--> statement-breakpoint
CREATE SECURITY POLICY rls.interviews_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interviews,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interviews AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interviews AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interview_devices,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interview_devices AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interview_devices AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interview_answer_events,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interview_answer_events AFTER INSERT,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interview_paradata,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interview_paradata AFTER INSERT,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.call_attempts,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.call_attempts AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.call_attempts AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.interviews TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.interview_devices TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON dbo.interview_answer_events TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON dbo.interview_paradata TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.call_attempts TO wansurvey_app;
--> statement-breakpoint
-- The history of answers and paradata is append-only: no privilege for the application, and a
-- trigger for the owner.
CREATE TRIGGER interview_answer_events_immutable ON dbo.interview_answer_events
  INSTEAD OF UPDATE, DELETE
AS
BEGIN
  THROW 50030, 'interview history is append-only', 1;
END;
--> statement-breakpoint
CREATE TRIGGER interview_paradata_immutable ON dbo.interview_paradata
  INSTEAD OF UPDATE, DELETE
AS
BEGIN
  THROW 50030, 'interview history is append-only', 1;
END;
--> statement-breakpoint
-- A call with a disposition is history: it can no longer change or be deleted. (An answered call
-- gets its disposition when its interview is submitted.)
CREATE TRIGGER call_attempts_guard ON dbo.call_attempts
  INSTEAD OF UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted)
    THROW 50031, 'call attempts with a disposition cannot change', 1;
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
