-- Interview recordings (ADR 0001, decision 5): the segments kept in the audio container, with
-- what is needed to check and play them. The files are written and read through the API only.
CREATE TABLE interview_audio (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT interview_audio_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT interview_audio_project_fk FOREIGN KEY REFERENCES projects (id),
  interview_id uniqueidentifier NOT NULL CONSTRAINT interview_audio_interview_fk FOREIGN KEY REFERENCES interviews (id),
  segment int NOT NULL,
  storage_key nvarchar(500) NOT NULL,
  content_type nvarchar(100) NOT NULL,
  bytes int NOT NULL,
  duration_ms int NOT NULL,
  sha256 char(64) NOT NULL,
  uploaded_at datetimeoffset(3) NOT NULL CONSTRAINT interview_audio_uploaded_df DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT interview_audio_segment_uq UNIQUE (interview_id, segment)
);
--> statement-breakpoint
CREATE INDEX interview_audio_project_idx ON interview_audio (project_id, interview_id);
--> statement-breakpoint
CREATE SECURITY POLICY rls.interview_audio_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interview_audio,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interview_audio AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interview_audio AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.interview_audio TO wansurvey_app;
