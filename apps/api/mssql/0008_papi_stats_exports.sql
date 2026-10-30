-- Paper, statistics and exports on SQL Server, the counterpart of drizzle/0015, 0017, 0033 and
-- 0044: the differences between the two keyings of a paper form, scanned PDFs with the forms found
-- and the page images, daily figures, data exports built by the worker, and read-only summary links.
-- The scan tables have no cascading foreign keys (SQL Server refuses two cascade paths from a
-- batch to its pages); the application deletes pages, forms, then the batch.
CREATE TABLE entry_mismatches (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT emismatches_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT emismatches_project_fk FOREIGN KEY REFERENCES projects (id),
  case_id uniqueidentifier NOT NULL CONSTRAINT emismatches_case_fk FOREIGN KEY REFERENCES cases (id),
  first_interview_id uniqueidentifier NOT NULL,
  second_interview_id uniqueidentifier NOT NULL,
  variable nvarchar(450) NOT NULL,
  first_value nvarchar(max) NULL,
  second_value nvarchar(max) NULL,
  -- open | resolved
  status nvarchar(32) NOT NULL CONSTRAINT emismatches_status_df DEFAULT 'open',
  resolved_value nvarchar(max) NULL,
  resolved_by uniqueidentifier NULL,
  resolved_at datetimeoffset(3) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT emismatches_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX entry_mismatches_project_idx ON entry_mismatches (tenant_id, project_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX entry_mismatches_uq ON entry_mismatches (second_interview_id, variable);
--> statement-breakpoint
CREATE TABLE papi_scan_batches (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT pbatches_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT pbatches_project_fk FOREIGN KEY REFERENCES projects (id),
  uploaded_by uniqueidentifier NULL CONSTRAINT pbatches_user_fk FOREIGN KEY REFERENCES users (id),
  file_name nvarchar(450) NOT NULL,
  -- Kept until it is read.
  pdf varbinary(max) NULL,
  -- queued | running | done | failed
  status nvarchar(32) NOT NULL CONSTRAINT pbatches_status_df DEFAULT 'queued',
  pages int NOT NULL CONSTRAINT pbatches_pages_df DEFAULT 0,
  error nvarchar(max) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT pbatches_created_df DEFAULT SYSDATETIMEOFFSET(),
  finished_at datetimeoffset(3) NULL,
  -- When the last attempt started, and how many there were (stuck jobs are retried).
  started_at datetimeoffset(3) NULL,
  attempts int NOT NULL CONSTRAINT pbatches_attempts_df DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX papi_scan_batches_project_idx ON papi_scan_batches (tenant_id, project_id, created_at);
--> statement-breakpoint
CREATE TABLE papi_scan_forms (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT pforms_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT pforms_project_fk FOREIGN KEY REFERENCES projects (id),
  batch_id uniqueidentifier NOT NULL CONSTRAINT pforms_batch_fk FOREIGN KEY REFERENCES papi_scan_batches (id),
  case_id uniqueidentifier NOT NULL CONSTRAINT pforms_case_fk FOREIGN KEY REFERENCES cases (id),
  questionnaire_version_id uniqueidentifier NOT NULL CONSTRAINT pforms_version_fk FOREIGN KEY REFERENCES questionnaire_versions (id),
  lang nvarchar(32) NOT NULL,
  interview_id uniqueidentifier NULL CONSTRAINT pforms_interview_fk FOREIGN KEY REFERENCES interviews (id),
  -- review (second round pending), done (submitted), duplicate, failed
  status nvarchar(32) NOT NULL,
  pages_expected int NOT NULL,
  -- JSON array of the page numbers found.
  pages_found nvarchar(max) NOT NULL CONSTRAINT pforms_found_df DEFAULT '[]' CONSTRAINT pforms_found_json CHECK (ISJSON(pages_found) = 1),
  -- What the second round must see: a JSON array of { name, kind, detail? }.
  issues nvarchar(max) NOT NULL CONSTRAINT pforms_issues_df DEFAULT '[]' CONSTRAINT pforms_issues_json CHECK (ISJSON(issues) = 1),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT pforms_created_df DEFAULT SYSDATETIMEOFFSET(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT pforms_updated_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX papi_scan_forms_batch_idx ON papi_scan_forms (batch_id);
--> statement-breakpoint
CREATE INDEX papi_scan_forms_interview_idx ON papi_scan_forms (interview_id);
--> statement-breakpoint
CREATE TABLE papi_scan_pages (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT ppages_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  batch_id uniqueidentifier NOT NULL CONSTRAINT ppages_batch_fk FOREIGN KEY REFERENCES papi_scan_batches (id),
  form_id uniqueidentifier NULL CONSTRAINT ppages_form_fk FOREIGN KEY REFERENCES papi_scan_forms (id),
  page_no int NOT NULL,
  form_page int NULL,
  -- no_code (unreadable or not one of ours), unknown_case, other_project, unaligned
  problem nvarchar(64) NULL,
  transform nvarchar(max) NULL CONSTRAINT ppages_transform_json CHECK (transform IS NULL OR ISJSON(transform) = 1),
  width int NOT NULL,
  height int NOT NULL,
  image varbinary(max) NOT NULL
);
--> statement-breakpoint
CREATE INDEX papi_scan_pages_batch_idx ON papi_scan_pages (batch_id, page_no);
--> statement-breakpoint
CREATE TABLE stats_daily (
  tenant_id uniqueidentifier NOT NULL CONSTRAINT sdaily_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT sdaily_project_fk FOREIGN KEY REFERENCES projects (id),
  -- The project's local day of submission.
  day date NOT NULL,
  mode nvarchar(16) NOT NULL,
  interviewer_id uniqueidentifier NULL,
  submitted int NOT NULL CONSTRAINT sdaily_submitted_df DEFAULT 0,
  completes int NOT NULL CONSTRAINT sdaily_completes_df DEFAULT 0,
  approved int NOT NULL CONSTRAINT sdaily_approved_df DEFAULT 0,
  rejected int NOT NULL CONSTRAINT sdaily_rejected_df DEFAULT 0,
  active_ms bigint NOT NULL CONSTRAINT sdaily_active_df DEFAULT 0,
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT sdaily_updated_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
-- NULLS NOT DISTINCT of PostgreSQL is how SQL Server treats a unique index: one row per
-- project, day, mode and interviewer, with at most one for "no interviewer".
CREATE UNIQUE INDEX stats_daily_uq ON stats_daily (project_id, day, mode, interviewer_id);
--> statement-breakpoint
CREATE TABLE exports (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT exports_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT exports_project_fk FOREIGN KEY REFERENCES projects (id),
  questionnaire_id uniqueidentifier NOT NULL,
  requested_by uniqueidentifier NOT NULL,
  options nvarchar(max) NOT NULL CONSTRAINT exports_options_json CHECK (ISJSON(options) = 1),
  -- queued | running | done | failed
  status nvarchar(32) NOT NULL CONSTRAINT exports_status_df DEFAULT 'queued',
  file_name nvarchar(450) NULL,
  content_type nvarchar(200) NULL,
  -- Exports made before files went to storage keep theirs here.
  file varbinary(max) NULL,
  -- The file in export storage (Blob Storage, or a directory in development).
  storage_key nvarchar(450) NULL,
  size int NULL,
  rows int NULL,
  error nvarchar(max) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT exports_created_df DEFAULT SYSDATETIMEOFFSET(),
  finished_at datetimeoffset(3) NULL,
  started_at datetimeoffset(3) NULL,
  attempts int NOT NULL CONSTRAINT exports_attempts_df DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX exports_project_idx ON exports (tenant_id, project_id, created_at);
--> statement-breakpoint
CREATE TABLE share_links (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT slinks_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT slinks_project_fk FOREIGN KEY REFERENCES projects (id),
  token_hash nvarchar(450) NOT NULL,
  token_enc nvarchar(max) NOT NULL,
  created_by uniqueidentifier NOT NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT slinks_created_df DEFAULT SYSDATETIMEOFFSET(),
  expires_at datetimeoffset(3) NULL,
  revoked_at datetimeoffset(3) NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX share_links_token_uq ON share_links (token_hash);
--> statement-breakpoint
-- Export pages are read in submission order after (submitted_at, id): with the id in the index
-- each page is a short index range, not a scan and sort of the whole project.
CREATE INDEX interviews_project_submitted_id_idx ON interviews (project_id, submitted_at, id);
--> statement-breakpoint
CREATE SECURITY POLICY rls.papi_exports_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.entry_mismatches,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.entry_mismatches AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.entry_mismatches AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.papi_scan_batches,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.papi_scan_batches AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.papi_scan_batches AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.papi_scan_forms,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.papi_scan_forms AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.papi_scan_forms AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.papi_scan_pages,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.papi_scan_pages AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.papi_scan_pages AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.stats_daily,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.stats_daily AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.stats_daily AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.exports,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.exports AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.exports AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.share_links,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.share_links AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.share_links AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.entry_mismatches TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.papi_scan_batches TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.papi_scan_forms TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.papi_scan_pages TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.stats_daily TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.exports TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.share_links TO wansurvey_app;
--> statement-breakpoint
-- Nightly jobs work across organisations: which ones exist.
CREATE PROCEDURE dbo.all_tenant_ids
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT id AS tenant_id FROM dbo.tenants;
END;
--> statement-breakpoint
-- A client's summary link arrives before any tenant context: its organisation, from the token
-- (hashed), when the link is still live.
CREATE PROCEDURE dbo.share_link_by_hash @hash nvarchar(450)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT id, tenant_id FROM dbo.share_links
  WHERE token_hash = @hash AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > SYSDATETIMEOFFSET());
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.all_tenant_ids TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.share_link_by_hash TO wansurvey_app;
