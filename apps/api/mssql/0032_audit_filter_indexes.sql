-- The activity log's filters by project and by case read ids out of the JSON details. Kept as
-- computed columns (in lower case, as the filters compare them) with an index each, so a log of
-- millions of entries answers them without reading every row. Computed by the database itself:
-- the append-only trigger and the application's INSERT stay as they are.
ALTER TABLE dbo.audit_log ADD
  target_ref AS LOWER(target_id) PERSISTED,
  project_ref AS LOWER(CAST(JSON_VALUE(details, '$.projectId') AS nvarchar(450))) PERSISTED,
  case_ref AS LOWER(CAST(JSON_VALUE(details, '$.caseId') AS nvarchar(450))) PERSISTED,
  case_external_ref AS LOWER(CAST(JSON_VALUE(details, '$.externalId') AS nvarchar(450))) PERSISTED;
--> statement-breakpoint
CREATE NONCLUSTERED INDEX audit_target_ref_idx ON dbo.audit_log (tenant_id, target_ref, at);
--> statement-breakpoint
CREATE NONCLUSTERED INDEX audit_project_ref_idx ON dbo.audit_log (tenant_id, project_ref, at);
--> statement-breakpoint
CREATE NONCLUSTERED INDEX audit_case_ref_idx ON dbo.audit_log (tenant_id, case_ref, at);
--> statement-breakpoint
CREATE NONCLUSTERED INDEX audit_case_external_ref_idx ON dbo.audit_log (tenant_id, case_external_ref, at);
