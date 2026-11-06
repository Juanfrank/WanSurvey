-- People registry (ADR 0002): the no-contact list and who took part in what, by contact value.
CREATE TABLE no_contact (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT no_contact_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  -- phone (E.164) | email (lower case)
  kind nvarchar(16) NOT NULL,
  value nvarchar(450) NOT NULL,
  -- A JSON list of modes (CATI, CAPI, CAWI, PAPI); null: every channel.
  channels nvarchar(max) NULL CONSTRAINT no_contact_channels_json CHECK (channels IS NULL OR ISJSON(channels) = 1),
  -- do_not_contact | not_interested | complaint | deceased | other
  reason nvarchar(32) NOT NULL,
  -- call | manual | import
  source nvarchar(16) NOT NULL,
  note nvarchar(1000) NULL,
  -- Null: permanent.
  expires_at datetimeoffset(3) NULL,
  created_by uniqueidentifier NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT no_contact_created_df DEFAULT SYSDATETIMEOFFSET(),
  lifted_at datetimeoffset(3) NULL,
  lifted_by uniqueidentifier NULL
);
--> statement-breakpoint
-- At most one active entry per value; lifted ones stay as history.
CREATE UNIQUE INDEX no_contact_active_uq ON no_contact (tenant_id, kind, value) WHERE lifted_at IS NULL;
--> statement-breakpoint
CREATE INDEX no_contact_value_idx ON no_contact (tenant_id, value);
--> statement-breakpoint
CREATE TABLE participations (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT participations_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  kind nvarchar(16) NOT NULL,
  value nvarchar(450) NOT NULL,
  channel nvarchar(16) NOT NULL,
  occurred_at datetimeoffset(3) NOT NULL,
  -- The disposition or result as text (COMPLETE, REFUSAL, ...).
  result nvarchar(64) NULL,
  project_name nvarchar(450) NULL,
  -- system | history
  source nvarchar(16) NOT NULL,
  case_id uniqueidentifier NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT participations_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE INDEX participations_value_idx ON participations (tenant_id, value, occurred_at DESC);
--> statement-breakpoint
CREATE SECURITY POLICY rls.no_contact_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.no_contact,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.no_contact AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.no_contact AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.participations,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.participations AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.participations AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.no_contact TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.participations TO wansurvey_app;
