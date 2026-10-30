-- Cases and sampling on SQL Server, the counterpart of drizzle/0006, 0009, 0022, 0026 and 0027:
-- the sample fields, cases with their contacts and history, uploaded imports, assignment rules,
-- the sampling plan with its frame units, and interviewer goals. Arrays and JSON are JSON text.
-- A unique index on a nullable questionnaire_id treats NULLs as equal in SQL Server, which is
-- what NULLS NOT DISTINCT asked of PostgreSQL (migration 0026).
CREATE TABLE sample_fields (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT sfields_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT sfields_project_fk FOREIGN KEY REFERENCES projects (id),
  name nvarchar(450) NOT NULL,
  label nvarchar(450) NULL,
  -- text | number | date | code
  type nvarchar(32) NOT NULL CONSTRAINT sfields_type_df DEFAULT 'text',
  pii bit NOT NULL CONSTRAINT sfields_pii_df DEFAULT 0,
  position int NOT NULL CONSTRAINT sfields_position_df DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX sample_fields_uq ON sample_fields (project_id, name);
--> statement-breakpoint
CREATE TABLE cases (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT cases_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT cases_project_fk FOREIGN KEY REFERENCES projects (id),
  -- The questionnaire whose case this is; null: any questionnaire of the project.
  questionnaire_id uniqueidentifier NULL CONSTRAINT cases_questionnaire_fk FOREIGN KEY REFERENCES questionnaires (id),
  external_id nvarchar(450) NOT NULL,
  sample nvarchar(max) NOT NULL CONSTRAINT cases_sample_df DEFAULT '{}' CONSTRAINT cases_sample_json CHECK (ISJSON(sample) = 1),
  -- Personal sample fields, sealed with AES-256-GCM by the application (H1).
  sample_pii nvarchar(max) NULL,
  -- JSON array of keyed hashes of the words of the personal fields, for search.
  sample_pii_index nvarchar(max) NULL CONSTRAINT cases_pii_index_json CHECK (sample_pii_index IS NULL OR ISJSON(sample_pii_index) = 1),
  anonymised_at datetimeoffset(3) NULL,
  -- fresh | assigned | in_progress | finalised | withdrawn
  status nvarchar(32) NOT NULL CONSTRAINT cases_status_df DEFAULT 'fresh',
  disposition nvarchar(64) NULL,
  priority int NOT NULL CONSTRAINT cases_priority_df DEFAULT 0,
  mode_preference nvarchar(32) NULL,
  assigned_to uniqueidentifier NULL CONSTRAINT cases_assigned_fk FOREIGN KEY REFERENCES users (id),
  assigned_at datetimeoffset(3) NULL,
  import_id uniqueidentifier NULL,
  attempts int NOT NULL CONSTRAINT cases_attempts_df DEFAULT 0,
  last_attempt_at datetimeoffset(3) NULL,
  next_contact_at datetimeoffset(3) NULL,
  callback_user_id uniqueidentifier NULL,
  call_lock_user_id uniqueidentifier NULL,
  call_lock_until datetimeoffset(3) NULL,
  checked_out_device nvarchar(450) NULL,
  checked_out_by uniqueidentifier NULL,
  checked_out_at datetimeoffset(3) NULL,
  frame_unit_id uniqueidentifier NULL,
  -- main | reserve | substitute | field; null for cases loaded without a plan.
  selection_role nvarchar(32) NULL,
  substitute_for uniqueidentifier NULL,
  inclusion_prob float NULL,
  base_weight float NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT cases_created_df DEFAULT SYSDATETIMEOFFSET(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT cases_updated_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX cases_external_uq ON cases (project_id, questionnaire_id, external_id);
--> statement-breakpoint
CREATE INDEX cases_questionnaire_idx ON cases (project_id, questionnaire_id, status);
--> statement-breakpoint
CREATE INDEX cases_expiry_idx ON cases (project_id, status, assigned_at);
--> statement-breakpoint
CREATE INDEX cases_next_contact_idx ON cases (project_id, next_contact_at);
--> statement-breakpoint
CREATE INDEX cases_status_idx ON cases (project_id, status);
--> statement-breakpoint
CREATE INDEX cases_assigned_idx ON cases (project_id, assigned_to);
--> statement-breakpoint
CREATE TABLE contacts (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT contacts_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  case_id uniqueidentifier NOT NULL CONSTRAINT contacts_case_fk FOREIGN KEY REFERENCES cases (id),
  -- phone | email | address
  type nvarchar(32) NOT NULL,
  value nvarchar(450) NOT NULL,
  label nvarchar(450) NULL,
  consent nvarchar(max) NOT NULL CONSTRAINT contacts_consent_df DEFAULT '{}' CONSTRAINT contacts_consent_json CHECK (ISJSON(consent) = 1),
  valid bit NOT NULL CONSTRAINT contacts_valid_df DEFAULT 1,
  -- Coordinates of an address from the geocoder (null until geocoded or when not found).
  lat float NULL,
  lng float NULL,
  geocode_quality nvarchar(64) NULL,
  geocoded_at datetimeoffset(3) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT contacts_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX contacts_case_idx ON contacts (case_id);
--> statement-breakpoint
-- Finds the same phone or e-mail in other projects (duplicate detection).
CREATE INDEX contacts_value_idx ON contacts (tenant_id, type, value);
--> statement-breakpoint
CREATE TABLE sample_imports (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT simports_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT simports_project_fk FOREIGN KEY REFERENCES projects (id),
  questionnaire_id uniqueidentifier NULL CONSTRAINT simports_questionnaire_fk FOREIGN KEY REFERENCES questionnaires (id),
  file_name nvarchar(450) NOT NULL,
  size int NOT NULL,
  sha256 nvarchar(128) NOT NULL,
  headers nvarchar(max) NOT NULL CONSTRAINT simports_headers_df DEFAULT '[]' CONSTRAINT simports_headers_json CHECK (ISJSON(headers) = 1),
  mapping nvarchar(max) NULL CONSTRAINT simports_mapping_json CHECK (mapping IS NULL OR ISJSON(mapping) = 1),
  -- uploaded | validated | committed | failed
  status nvarchar(32) NOT NULL CONSTRAINT simports_status_df DEFAULT 'uploaded',
  report nvarchar(max) NULL CONSTRAINT simports_report_json CHECK (report IS NULL OR ISJSON(report) = 1),
  rows int NOT NULL CONSTRAINT simports_rows_df DEFAULT 0,
  -- cases (load cases directly) | frame (units of the sampling frame)
  target nvarchar(32) NOT NULL CONSTRAINT simports_target_df DEFAULT 'cases',
  source_label nvarchar(450) NULL,
  uploaded_by uniqueidentifier NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT simports_created_df DEFAULT SYSDATETIMEOFFSET(),
  committed_at datetimeoffset(3) NULL
);
--> statement-breakpoint
CREATE TABLE sample_import_rows (
  tenant_id uniqueidentifier NOT NULL CONSTRAINT simportrows_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  import_id uniqueidentifier NOT NULL CONSTRAINT simportrows_import_fk FOREIGN KEY REFERENCES sample_imports (id),
  row_no int NOT NULL,
  data nvarchar(max) NOT NULL CONSTRAINT simportrows_json CHECK (ISJSON(data) = 1),
  CONSTRAINT sample_import_rows_pk PRIMARY KEY (import_id, row_no)
);
--> statement-breakpoint
CREATE TABLE assignments (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT assignments_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT assignments_project_fk FOREIGN KEY REFERENCES projects (id),
  user_id uniqueidentifier NOT NULL CONSTRAINT assignments_user_fk FOREIGN KEY REFERENCES users (id),
  questionnaire_id uniqueidentifier NULL CONSTRAINT assignments_questionnaire_fk FOREIGN KEY REFERENCES questionnaires (id),
  -- list | rule
  kind nvarchar(16) NOT NULL,
  name nvarchar(450) NULL,
  filter nvarchar(max) NULL,
  quota int NULL,
  active bit NOT NULL CONSTRAINT assignments_active_df DEFAULT 1,
  created_by uniqueidentifier NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT assignments_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX assignments_project_idx ON assignments (project_id);
--> statement-breakpoint
CREATE TABLE case_events (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT cevents_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  case_id uniqueidentifier NOT NULL CONSTRAINT cevents_case_fk FOREIGN KEY REFERENCES cases (id),
  type nvarchar(64) NOT NULL,
  details nvarchar(max) NOT NULL CONSTRAINT cevents_details_df DEFAULT '{}' CONSTRAINT cevents_details_json CHECK (ISJSON(details) = 1),
  actor_user_id uniqueidentifier NULL,
  at datetimeoffset(3) NOT NULL CONSTRAINT cevents_at_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX case_events_case_idx ON case_events (case_id, at);
--> statement-breakpoint
CREATE TABLE sampling_plans (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT splans_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT splans_project_fk FOREIGN KEY REFERENCES projects (id),
  questionnaire_id uniqueidentifier NULL CONSTRAINT splans_questionnaire_fk FOREIGN KEY REFERENCES questionnaires (id),
  source nvarchar(max) NOT NULL CONSTRAINT splans_source_df DEFAULT '{}' CONSTRAINT splans_source_json CHECK (ISJSON(source) = 1),
  design nvarchar(max) NOT NULL CONSTRAINT splans_design_df DEFAULT '{}' CONSTRAINT splans_design_json CHECK (ISJSON(design) = 1),
  size nvarchar(max) NOT NULL CONSTRAINT splans_size_df DEFAULT '{}' CONSTRAINT splans_size_json CHECK (ISJSON(size) = 1),
  eligibility nvarchar(max) NULL,
  exclusions nvarchar(max) NULL,
  quotas nvarchar(max) NOT NULL CONSTRAINT splans_quotas_df DEFAULT '[]' CONSTRAINT splans_quotas_json CHECK (ISJSON(quotas) = 1),
  substitution nvarchar(max) NOT NULL CONSTRAINT splans_substitution_df DEFAULT '{}' CONSTRAINT splans_substitution_json CHECK (ISJSON(substitution) = 1),
  cross_checks nvarchar(max) NOT NULL CONSTRAINT splans_checks_df DEFAULT '[]' CONSTRAINT splans_checks_json CHECK (ISJSON(cross_checks) = 1),
  seed nvarchar(450) NOT NULL,
  -- draft | selected
  status nvarchar(32) NOT NULL CONSTRAINT splans_status_df DEFAULT 'draft',
  result nvarchar(max) NULL CONSTRAINT splans_result_json CHECK (result IS NULL OR ISJSON(result) = 1),
  selected_at datetimeoffset(3) NULL,
  selected_by uniqueidentifier NULL,
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT splans_updated_df DEFAULT SYSDATETIMEOFFSET(),
  updated_by uniqueidentifier NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX sampling_plans_questionnaire_uq ON sampling_plans (project_id, questionnaire_id);
--> statement-breakpoint
CREATE TABLE frame_units (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT funits_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT funits_project_fk FOREIGN KEY REFERENCES projects (id),
  questionnaire_id uniqueidentifier NULL CONSTRAINT funits_questionnaire_fk FOREIGN KEY REFERENCES questionnaires (id),
  external_id nvarchar(450) NOT NULL,
  source_label nvarchar(450) NULL,
  sample nvarchar(max) NOT NULL CONSTRAINT funits_sample_df DEFAULT '{}' CONSTRAINT funits_sample_json CHECK (ISJSON(sample) = 1),
  sample_pii nvarchar(max) NULL,
  contacts nvarchar(max) NOT NULL CONSTRAINT funits_contacts_df DEFAULT '[]' CONSTRAINT funits_contacts_json CHECK (ISJSON(contacts) = 1),
  import_id uniqueidentifier NULL,
  eligible bit NOT NULL CONSTRAINT funits_eligible_df DEFAULT 1,
  -- Why the unit is out (ineligible or excluded), when it is.
  exclusion nvarchar(max) NULL,
  -- main | reserve once selected; null otherwise.
  role nvarchar(32) NULL,
  -- Order in which reserves are released (1 first).
  release_order int NULL,
  released_at datetimeoffset(3) NULL,
  inclusion_prob float NULL,
  base_weight float NULL,
  stratum nvarchar(450) NULL,
  case_id uniqueidentifier NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT funits_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX frame_units_external_uq ON frame_units (project_id, questionnaire_id, external_id);
--> statement-breakpoint
CREATE INDEX frame_units_role_idx ON frame_units (tenant_id, project_id, role);
--> statement-breakpoint
CREATE TABLE interviewer_goals (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT goals_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT goals_project_fk FOREIGN KEY REFERENCES projects (id),
  -- Null: completes of any questionnaire of the project count.
  questionnaire_id uniqueidentifier NULL CONSTRAINT goals_questionnaire_fk FOREIGN KEY REFERENCES questionnaires (id),
  -- Null: the whole team.
  user_id uniqueidentifier NULL CONSTRAINT goals_user_fk FOREIGN KEY REFERENCES users (id),
  -- period (once for the dates), daily, business_days, weekly or monthly.
  frequency nvarchar(32) NOT NULL CONSTRAINT goals_frequency_df DEFAULT 'period',
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  target int NOT NULL,
  created_by uniqueidentifier NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT goals_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX interviewer_goals_project_idx ON interviewer_goals (tenant_id, project_id, user_id);
--> statement-breakpoint
CREATE SECURITY POLICY rls.cases_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sample_fields,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sample_fields AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sample_fields AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.cases,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.cases AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.cases AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.contacts,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.contacts AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.contacts AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sample_imports,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sample_imports AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sample_imports AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sample_import_rows,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sample_import_rows AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sample_import_rows AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.assignments,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.assignments AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.assignments AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.case_events,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.case_events AFTER INSERT,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sampling_plans,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sampling_plans AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.sampling_plans AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.frame_units,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.frame_units AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.frame_units AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interviewer_goals,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interviewer_goals AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.interviewer_goals AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.sample_fields TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.cases TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.contacts TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.sample_imports TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.sample_import_rows TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.assignments TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON dbo.case_events TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.sampling_plans TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.frame_units TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.interviewer_goals TO wansurvey_app;
--> statement-breakpoint
-- A case's history is append-only: no privilege for the application, and a trigger for the owner.
CREATE TRIGGER case_events_immutable ON dbo.case_events
  INSTEAD OF UPDATE, DELETE
AS
BEGIN
  THROW 50020, 'case_events is append-only', 1;
END;
