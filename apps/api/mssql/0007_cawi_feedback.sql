-- Web surveys, e-mail and quick feedback on SQL Server, the counterpart of drizzle/0014, 0021 and
-- 0023: templates, waves (mailings), invitations with their delivery tracking, suppressed
-- addresses, open links, and feedback points with their responses. Lists are JSON text. A unique
-- index on columns that are often NULL carries a filter, because SQL Server treats NULLs as equal.
CREATE TABLE email_templates (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT etemplates_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT etemplates_project_fk FOREIGN KEY REFERENCES projects (id),
  -- invitation | reminder
  kind nvarchar(32) NOT NULL,
  language nvarchar(32) NOT NULL,
  subject nvarchar(450) NOT NULL,
  -- Plain text with {{case.*}}, {{link}} and {{unsubscribe}}.
  body nvarchar(max) NOT NULL,
  updated_by uniqueidentifier NULL,
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT etemplates_updated_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX email_templates_uq ON email_templates (project_id, kind, language);
--> statement-breakpoint
CREATE TABLE waves (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT waves_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT waves_project_fk FOREIGN KEY REFERENCES projects (id),
  questionnaire_id uniqueidentifier NOT NULL CONSTRAINT waves_questionnaire_fk FOREIGN KEY REFERENCES questionnaires (id),
  name nvarchar(450) NOT NULL,
  -- draft | sending | sent
  status nvarchar(32) NOT NULL CONSTRAINT waves_status_df DEFAULT 'draft',
  -- email (invitations are sent) | links (a personal link per case, nothing sent)
  channel nvarchar(16) NOT NULL CONSTRAINT waves_channel_df DEFAULT 'email',
  -- Case rule (as in assignment rules); null means every eligible case.
  filter nvarchar(max) NULL,
  -- Days after the invitation for each reminder, as a JSON array such as [3,7].
  reminder_days nvarchar(max) NOT NULL CONSTRAINT waves_reminders_df DEFAULT '[]' CONSTRAINT waves_reminders_json CHECK (ISJSON(reminder_days) = 1),
  send_at datetimeoffset(3) NULL,
  -- A hard bounce moves the case to telephone interviewing.
  bounces_to_cati bit NOT NULL CONSTRAINT waves_bounces_df DEFAULT 0,
  created_by uniqueidentifier NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT waves_created_df DEFAULT SYSDATETIMEOFFSET(),
  sent_at datetimeoffset(3) NULL
);
--> statement-breakpoint
CREATE INDEX waves_project_idx ON waves (tenant_id, project_id);
--> statement-breakpoint
CREATE TABLE invitations (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT invitations_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT invitations_project_fk FOREIGN KEY REFERENCES projects (id),
  questionnaire_id uniqueidentifier NOT NULL CONSTRAINT invitations_questionnaire_fk FOREIGN KEY REFERENCES questionnaires (id),
  wave_id uniqueidentifier NULL CONSTRAINT invitations_wave_fk FOREIGN KEY REFERENCES waves (id),
  case_id uniqueidentifier NULL CONSTRAINT invitations_case_fk FOREIGN KEY REFERENCES cases (id),
  contact_id uniqueidentifier NULL,
  email nvarchar(450) NULL,
  -- Stored hashed (lookup) and encrypted (to send reminders); the raw token is only in the link.
  token_hash nvarchar(450) NOT NULL,
  token_enc nvarchar(max) NOT NULL,
  language nvarchar(32) NOT NULL,
  -- queued | sent | failed | bounced | suppressed | completed
  status nvarchar(32) NOT NULL CONSTRAINT invitations_status_df DEFAULT 'queued',
  send_attempts int NOT NULL CONSTRAINT invitations_attempts_df DEFAULT 0,
  queued_at datetimeoffset(3) NOT NULL CONSTRAINT invitations_queued_df DEFAULT SYSDATETIMEOFFSET(),
  sent_at datetimeoffset(3) NULL,
  delivered_at datetimeoffset(3) NULL,
  bounced_at datetimeoffset(3) NULL,
  bounce_type nvarchar(32) NULL,
  opened_at datetimeoffset(3) NULL,
  clicked_at datetimeoffset(3) NULL,
  started_at datetimeoffset(3) NULL,
  completed_at datetimeoffset(3) NULL,
  reminders_sent int NOT NULL CONSTRAINT invitations_reminders_df DEFAULT 0,
  last_reminder_at datetimeoffset(3) NULL,
  -- A dispatcher took it to send until this time; after it, another may (lost worker).
  lease_until datetimeoffset(3) NULL,
  last_error nvarchar(max) NULL,
  interview_id uniqueidentifier NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX invitations_token_uq ON invitations (token_hash);
--> statement-breakpoint
-- One invitation per case in a wave (invitations without a wave or a case are not constrained).
CREATE UNIQUE INDEX invitations_wave_case_uq ON invitations (wave_id, case_id)
  WHERE wave_id IS NOT NULL AND case_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX invitations_status_idx ON invitations (tenant_id, status);
--> statement-breakpoint
CREATE INDEX invitations_interview_idx ON invitations (interview_id);
--> statement-breakpoint
-- The dispatcher reads the oldest queued invitations, and the sent ones still awaiting an answer.
CREATE INDEX invitations_queue_idx ON invitations (tenant_id, queued_at) WHERE status = 'queued';
--> statement-breakpoint
CREATE INDEX invitations_reminder_idx ON invitations (tenant_id, sent_at)
  WHERE status = 'sent' AND completed_at IS NULL;
--> statement-breakpoint
CREATE TABLE suppressions (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT suppressions_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  email nvarchar(450) COLLATE Latin1_General_100_CI_AS NOT NULL,
  -- hard_bounce | complaint | unsubscribe
  reason nvarchar(32) NOT NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT suppressions_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX suppressions_uq ON suppressions (tenant_id, email);
--> statement-breakpoint
CREATE TABLE open_links (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT olinks_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT olinks_project_fk FOREIGN KEY REFERENCES projects (id),
  questionnaire_id uniqueidentifier NOT NULL CONSTRAINT olinks_questionnaire_fk FOREIGN KEY REFERENCES questionnaires (id),
  slug nvarchar(200) NOT NULL,
  active bit NOT NULL CONSTRAINT olinks_active_df DEFAULT 1,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT olinks_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX open_links_slug_uq ON open_links (slug);
--> statement-breakpoint
CREATE TABLE feedback_points (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT fpoints_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT fpoints_project_fk FOREIGN KEY REFERENCES projects (id),
  name nvarchar(450) NOT NULL,
  -- LocalizedText, as JSON.
  question nvarchar(max) NOT NULL CONSTRAINT fpoints_question_json CHECK (ISJSON(question) = 1),
  faces smallint NOT NULL CONSTRAINT fpoints_faces_df DEFAULT 3,
  ask_comment bit NOT NULL CONSTRAINT fpoints_comment_df DEFAULT 1,
  slug nvarchar(200) NOT NULL,
  active bit NOT NULL CONSTRAINT fpoints_active_df DEFAULT 1,
  -- Goes up when the questions change.
  version int NOT NULL CONSTRAINT fpoints_version_df DEFAULT 1,
  -- Follow-up questions after the Likert, as a JSON array.
  items nvarchar(max) NOT NULL CONSTRAINT fpoints_items_df DEFAULT '[]' CONSTRAINT fpoints_items_json CHECK (ISJSON(items) = 1),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT fpoints_created_df DEFAULT SYSDATETIMEOFFSET(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT fpoints_updated_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX feedback_points_slug_uq ON feedback_points (slug);
--> statement-breakpoint
CREATE INDEX feedback_points_project_idx ON feedback_points (tenant_id, project_id);
--> statement-breakpoint
CREATE TABLE feedback_responses (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT fresponses_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  point_id uniqueidentifier NOT NULL CONSTRAINT fresponses_point_fk FOREIGN KEY REFERENCES feedback_points (id),
  -- 1 (worst) ... faces (best).
  score smallint NOT NULL,
  -- link | widget | paper
  channel nvarchar(16) NOT NULL CONSTRAINT fresponses_channel_df DEFAULT 'link',
  -- What the answer is about, from the link (?ref=ticket-123).
  ref nvarchar(450) NULL,
  comment nvarchar(max) NULL,
  -- Lets the browser that answered add a comment once (hash of a one-time key).
  edit_hash nvarchar(450) NULL,
  -- Answers to the follow-up questions, by item id.
  answers nvarchar(max) NULL CONSTRAINT fresponses_answers_json CHECK (answers IS NULL OR ISJSON(answers) = 1),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT fresponses_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX feedback_responses_point_idx ON feedback_responses (tenant_id, point_id, created_at);
--> statement-breakpoint
CREATE SECURITY POLICY rls.cawi_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.email_templates,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.email_templates AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.email_templates AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.waves,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.waves AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.waves AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.invitations,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.invitations AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.invitations AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.suppressions,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.suppressions AFTER INSERT,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.open_links,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.open_links AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.open_links AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.feedback_points,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.feedback_points AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.feedback_points AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.feedback_responses,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.feedback_responses AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.feedback_responses AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.email_templates TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.waves TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.invitations TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON dbo.suppressions TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.open_links TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.feedback_points TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.feedback_responses TO wansurvey_app;
--> statement-breakpoint
-- Respondent links and provider webhooks arrive before any tenant context: they find the
-- organisation from the token (hashed), the invitation id or the slug, and nothing else. The
-- procedures run as the owner, who is not under the security policy.
CREATE PROCEDURE dbo.invitation_by_token @hash nvarchar(450)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT id, tenant_id FROM dbo.invitations WHERE token_hash = @hash;
END;
--> statement-breakpoint
CREATE PROCEDURE dbo.invitation_tenant @id uniqueidentifier
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT tenant_id FROM dbo.invitations WHERE id = @id;
END;
--> statement-breakpoint
CREATE PROCEDURE dbo.open_link_by_slug @slug nvarchar(200)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT id, tenant_id FROM dbo.open_links WHERE slug = @slug AND active = 1;
END;
--> statement-breakpoint
CREATE PROCEDURE dbo.feedback_point_by_slug @slug nvarchar(200)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT id, tenant_id FROM dbo.feedback_points WHERE slug = @slug AND active = 1;
END;
--> statement-breakpoint
-- The dispatcher works across organisations: which ones have e-mail waiting to go out.
CREATE PROCEDURE dbo.tenants_with_mail_due
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT DISTINCT tenant_id FROM dbo.invitations
  WHERE status = 'queued' OR (status = 'sent' AND wave_id IS NOT NULL AND completed_at IS NULL);
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.invitation_by_token TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.invitation_tenant TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.open_link_by_slug TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.feedback_point_by_slug TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.tenants_with_mail_due TO wansurvey_app;
