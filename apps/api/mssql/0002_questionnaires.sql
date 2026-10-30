-- The questionnaire vertical on SQL Server, the counterpart of drizzle/0005, 0008, 0020 and 0032:
-- questionnaires (with their state), published versions, regression scenarios, review comments,
-- who is editing, and the library of saved items. Arrays and JSON are JSON text checked with ISJSON.
CREATE TABLE questionnaires (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT questionnaires_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT questionnaires_project_fk FOREIGN KEY REFERENCES projects (id),
  name nvarchar(450) NOT NULL,
  draft nvarchar(max) NOT NULL CONSTRAINT questionnaires_draft_json CHECK (ISJSON(draft) = 1),
  draft_revision int NOT NULL CONSTRAINT questionnaires_rev_df DEFAULT 1,
  -- active, disabled (no new fills in any mode) or completed (closed for good).
  state nvarchar(32) NOT NULL CONSTRAINT questionnaires_state_df DEFAULT 'active',
  state_changed_at datetimeoffset(3) NULL,
  -- A completed questionnaire's continuation: its web links send respondents there.
  successor_id uniqueidentifier NULL CONSTRAINT questionnaires_successor_fk FOREIGN KEY REFERENCES questionnaires (id),
  updated_by uniqueidentifier NULL,
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT questionnaires_updated_df DEFAULT SYSDATETIMEOFFSET(),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT questionnaires_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX questionnaires_project_idx ON questionnaires (tenant_id, project_id);
--> statement-breakpoint
CREATE TABLE questionnaire_versions (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT qversions_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  questionnaire_id uniqueidentifier NOT NULL CONSTRAINT qversions_q_fk FOREIGN KEY REFERENCES questionnaires (id),
  version int NOT NULL,
  -- published | retired
  status nvarchar(32) NOT NULL CONSTRAINT qversions_status_df DEFAULT 'published',
  definition nvarchar(max) NOT NULL CONSTRAINT qversions_definition_json CHECK (ISJSON(definition) = 1),
  compiled nvarchar(max) NOT NULL CONSTRAINT qversions_compiled_json CHECK (ISJSON(compiled) = 1),
  hash nvarchar(450) NOT NULL,
  -- Breaking-change mapping from the previous version, when there was one.
  mapping nvarchar(max) NULL CONSTRAINT qversions_mapping_json CHECK (mapping IS NULL OR ISJSON(mapping) = 1),
  published_by uniqueidentifier NULL,
  published_at datetimeoffset(3) NOT NULL CONSTRAINT qversions_published_df DEFAULT SYSDATETIMEOFFSET(),
  retired_at datetimeoffset(3) NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX questionnaire_versions_uq ON questionnaire_versions (questionnaire_id, version);
--> statement-breakpoint
CREATE TABLE questionnaire_scenarios (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT qscenarios_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  questionnaire_id uniqueidentifier NOT NULL CONSTRAINT qscenarios_q_fk FOREIGN KEY REFERENCES questionnaires (id),
  name nvarchar(450) NOT NULL,
  scenario nvarchar(max) NOT NULL CONSTRAINT qscenarios_json CHECK (ISJSON(scenario) = 1),
  created_by uniqueidentifier NULL,
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT qscenarios_updated_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX questionnaire_scenarios_name_uq ON questionnaire_scenarios (questionnaire_id, name);
--> statement-breakpoint
CREATE TABLE questionnaire_comments (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT qcomments_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  questionnaire_id uniqueidentifier NOT NULL CONSTRAINT qcomments_q_fk FOREIGN KEY REFERENCES questionnaires (id),
  item_id nvarchar(450) NULL,
  parent_id uniqueidentifier NULL,
  author_id uniqueidentifier NOT NULL,
  body nvarchar(max) NOT NULL,
  resolved_at datetimeoffset(3) NULL,
  resolved_by uniqueidentifier NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT qcomments_created_df DEFAULT SYSDATETIMEOFFSET(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT qcomments_updated_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX questionnaire_comments_q_idx ON questionnaire_comments (questionnaire_id, created_at);
--> statement-breakpoint
CREATE TABLE questionnaire_presence (
  tenant_id uniqueidentifier NOT NULL CONSTRAINT qpresence_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  questionnaire_id uniqueidentifier NOT NULL CONSTRAINT qpresence_q_fk FOREIGN KEY REFERENCES questionnaires (id),
  user_id uniqueidentifier NOT NULL,
  item_id nvarchar(450) NULL,
  last_seen datetimeoffset(3) NOT NULL CONSTRAINT qpresence_seen_df DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT questionnaire_presence_pk PRIMARY KEY (questionnaire_id, user_id)
);
--> statement-breakpoint
CREATE TABLE library_items (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT library_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  name nvarchar(450) NOT NULL,
  description nvarchar(max) NULL,
  tags nvarchar(max) NOT NULL CONSTRAINT library_tags_df DEFAULT '[]' CONSTRAINT library_tags_json CHECK (ISJSON(tags) = 1),
  content nvarchar(max) NOT NULL CONSTRAINT library_content_json CHECK (ISJSON(content) = 1),
  languages nvarchar(max) NOT NULL CONSTRAINT library_languages_json CHECK (ISJSON(languages) = 1),
  created_by uniqueidentifier NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT library_created_df DEFAULT SYSDATETIMEOFFSET(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT library_updated_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX library_items_tenant_idx ON library_items (tenant_id, name);
--> statement-breakpoint
CREATE SECURITY POLICY rls.questionnaires_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaires,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaires AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaires AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaire_versions,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaire_versions AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaire_versions AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaire_scenarios,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaire_scenarios AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaire_scenarios AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaire_comments,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaire_comments AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaire_comments AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaire_presence,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaire_presence AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.questionnaire_presence AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.library_items,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.library_items AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.library_items AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.questionnaires TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.questionnaire_versions TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.questionnaire_scenarios TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.questionnaire_comments TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.questionnaire_presence TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.library_items TO wansurvey_app;
--> statement-breakpoint
-- Published versions are immutable: only published -> retired may change, nothing is deleted.
-- INSTEAD OF triggers refuse with THROW (which leaves the transaction to its owner to roll back)
-- and, when the change is allowed, apply only the two columns that may change.
CREATE TRIGGER questionnaire_versions_no_delete ON dbo.questionnaire_versions
  INSTEAD OF DELETE
AS
BEGIN
  THROW 50010, 'questionnaire versions cannot be deleted', 1;
END;
--> statement-breakpoint
CREATE TRIGGER questionnaire_versions_guard ON dbo.questionnaire_versions
  INSTEAD OF UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS (
    SELECT 1 FROM inserted i JOIN dbo.questionnaire_versions v ON v.id = i.id
    WHERE i.definition <> v.definition OR i.compiled <> v.compiled OR i.hash <> v.hash
      OR ISNULL(i.mapping, N'') <> ISNULL(v.mapping, N'')
      OR i.version <> v.version OR i.questionnaire_id <> v.questionnaire_id
      OR i.tenant_id <> v.tenant_id OR i.published_at <> v.published_at
      OR ISNULL(CAST(i.published_by AS nvarchar(40)), N'') <> ISNULL(CAST(v.published_by AS nvarchar(40)), N'')
  )
    THROW 50011, 'published questionnaire versions are immutable', 1;
  IF EXISTS (
    SELECT 1 FROM inserted i JOIN dbo.questionnaire_versions v ON v.id = i.id
    WHERE NOT (v.status = N'published' AND i.status = N'retired')
  )
    THROW 50012, 'a version can only go from published to retired', 1;
  UPDATE v SET status = i.status, retired_at = i.retired_at
  FROM dbo.questionnaire_versions v JOIN inserted i ON i.id = v.id;
END;
