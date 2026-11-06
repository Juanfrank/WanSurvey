-- Approval before publishing a questionnaire (the project's `publishApproval.required`): one request
-- per draft revision, decided by someone with questionnaires.approve other than the author. A
-- publish needs an approved request for the draft as it stands; it is consumed by the publish.
CREATE TABLE publish_requests (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT publish_requests_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  questionnaire_id uniqueidentifier NOT NULL CONSTRAINT publish_requests_questionnaire_fk FOREIGN KEY REFERENCES questionnaires (id),
  draft_revision int NOT NULL,
  -- pending, approved, rejected, withdrawn (replaced by a newer request) or consumed (published).
  status nvarchar(16) NOT NULL CONSTRAINT publish_requests_status_df DEFAULT 'pending',
  note nvarchar(1000) NULL,
  requested_by uniqueidentifier NOT NULL,
  requested_at datetimeoffset(3) NOT NULL CONSTRAINT publish_requests_requested_df DEFAULT SYSDATETIMEOFFSET(),
  decided_by uniqueidentifier NULL,
  decided_at datetimeoffset(3) NULL,
  decision_note nvarchar(1000) NULL
);
--> statement-breakpoint
CREATE INDEX publish_requests_questionnaire_idx ON publish_requests (tenant_id, questionnaire_id, requested_at DESC);
--> statement-breakpoint
CREATE SECURITY POLICY rls.publish_requests_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.publish_requests,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.publish_requests AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.publish_requests AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.publish_requests TO wansurvey_app;
