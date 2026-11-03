-- Web notifications (ADR 0001, decision 6): the browsers a person has allowed to be told things,
-- and the notifications waiting to go out (kept in the database like the webhook deliveries, so
-- a restart loses none and a push service that is down is tried again).
CREATE TABLE push_subscriptions (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT push_subscriptions_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  user_id uniqueidentifier NOT NULL CONSTRAINT push_subscriptions_user_fk FOREIGN KEY REFERENCES users (id),
  endpoint nvarchar(1000) NOT NULL,
  endpoint_hash char(64) NOT NULL,
  p256dh nvarchar(200) NOT NULL,
  auth nvarchar(100) NOT NULL,
  categories nvarchar(max) NOT NULL,
  lang nvarchar(8) NOT NULL CONSTRAINT push_subscriptions_lang_df DEFAULT 'es',
  user_agent nvarchar(300) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT push_subscriptions_created_df DEFAULT SYSDATETIMEOFFSET(),
  last_ok_at datetimeoffset(3) NULL,
  CONSTRAINT push_subscriptions_endpoint_uq UNIQUE (tenant_id, endpoint_hash)
);
--> statement-breakpoint
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (tenant_id, user_id);
--> statement-breakpoint
CREATE TABLE push_outbox (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT push_outbox_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  user_id uniqueidentifier NOT NULL CONSTRAINT push_outbox_user_fk FOREIGN KEY REFERENCES users (id),
  category nvarchar(32) NOT NULL,
  payload nvarchar(max) NOT NULL,
  dedupe_key nvarchar(200) NULL,
  status nvarchar(16) NOT NULL CONSTRAINT push_outbox_status_df DEFAULT 'pending',
  attempt int NOT NULL CONSTRAINT push_outbox_attempt_df DEFAULT 0,
  next_attempt_at datetimeoffset(3) NOT NULL CONSTRAINT push_outbox_next_df DEFAULT SYSDATETIMEOFFSET(),
  claimed_until datetimeoffset(3) NULL,
  last_error nvarchar(500) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT push_outbox_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX push_outbox_due_idx ON push_outbox (status, next_attempt_at);
--> statement-breakpoint
CREATE UNIQUE INDEX push_outbox_dedupe_uq ON push_outbox (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
--> statement-breakpoint
CREATE SECURITY POLICY rls.push_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.push_subscriptions,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.push_subscriptions AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.push_subscriptions AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.push_outbox,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.push_outbox AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.push_outbox AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.push_subscriptions TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.push_outbox TO wansurvey_app;
--> statement-breakpoint
-- The dispatcher works across organisations: which ones have notifications due.
CREATE PROCEDURE dbo.tenants_with_push_due
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT DISTINCT tenant_id FROM dbo.push_outbox
  WHERE status = 'pending' AND next_attempt_at <= SYSDATETIMEOFFSET();
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.tenants_with_push_due TO wansurvey_app;
