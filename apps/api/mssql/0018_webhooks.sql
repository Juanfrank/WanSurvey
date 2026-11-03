-- Outgoing webhooks (ADR 0001, decision 3, phase B): the endpoints an organisation subscribes, and
-- the deliveries kept in the database (claimed like the jobs, so they work without Redis and survive
-- a restart). The signing secret is encrypted with the application key: it is needed to sign.
CREATE TABLE webhook_endpoints (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT webhook_endpoints_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NULL CONSTRAINT webhook_endpoints_project_fk FOREIGN KEY REFERENCES projects (id),
  url nvarchar(1000) NOT NULL,
  events nvarchar(max) NOT NULL,
  secret_enc nvarchar(max) NOT NULL,
  previous_secret_enc nvarchar(max) NULL,
  previous_secret_until datetimeoffset(3) NULL,
  enabled bit NOT NULL CONSTRAINT webhook_endpoints_enabled_df DEFAULT 1,
  failure_streak int NOT NULL CONSTRAINT webhook_endpoints_streak_df DEFAULT 0,
  disabled_reason nvarchar(200) NULL,
  created_by uniqueidentifier NOT NULL CONSTRAINT webhook_endpoints_creator_fk FOREIGN KEY REFERENCES users (id),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT webhook_endpoints_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX webhook_endpoints_tenant_idx ON webhook_endpoints (tenant_id, created_at);
--> statement-breakpoint
CREATE TABLE webhook_deliveries (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT webhook_deliveries_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  endpoint_id uniqueidentifier NOT NULL CONSTRAINT webhook_deliveries_endpoint_fk FOREIGN KEY REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  event_id uniqueidentifier NOT NULL,
  event nvarchar(64) NOT NULL,
  payload nvarchar(max) NOT NULL,
  status nvarchar(16) NOT NULL CONSTRAINT webhook_deliveries_status_df DEFAULT 'pending',
  attempt int NOT NULL CONSTRAINT webhook_deliveries_attempt_df DEFAULT 0,
  next_attempt_at datetimeoffset(3) NOT NULL CONSTRAINT webhook_deliveries_next_df DEFAULT SYSDATETIMEOFFSET(),
  claimed_until datetimeoffset(3) NULL,
  last_status_code int NULL,
  last_error nvarchar(500) NULL,
  duration_ms int NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT webhook_deliveries_created_df DEFAULT SYSDATETIMEOFFSET(),
  delivered_at datetimeoffset(3) NULL
);
--> statement-breakpoint
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (status, next_attempt_at);
--> statement-breakpoint
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at);
--> statement-breakpoint
CREATE SECURITY POLICY rls.webhooks_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.webhook_endpoints,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.webhook_endpoints AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.webhook_endpoints AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.webhook_deliveries,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.webhook_deliveries AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.webhook_deliveries AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.webhook_endpoints TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.webhook_deliveries TO wansurvey_app;
--> statement-breakpoint
-- The dispatcher works across organisations: which ones have deliveries due.
CREATE PROCEDURE dbo.tenants_with_webhooks_due
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT DISTINCT tenant_id FROM dbo.webhook_deliveries
  WHERE status = 'pending' AND next_attempt_at <= SYSDATETIMEOFFSET();
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.tenants_with_webhooks_due TO wansurvey_app;
