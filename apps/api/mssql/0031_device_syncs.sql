-- The last time each interviewer's device synchronised with a project (169): written when the
-- device downloads or gives back cases and when its "Sync now" reaches the server, so a
-- supervisor sees who holds cases on a device without having synchronised for days.
CREATE TABLE device_syncs (
  tenant_id uniqueidentifier NOT NULL CONSTRAINT device_syncs_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT device_syncs_project_fk FOREIGN KEY REFERENCES projects (id),
  user_id uniqueidentifier NOT NULL CONSTRAINT device_syncs_user_fk FOREIGN KEY REFERENCES users (id),
  device_id nvarchar(200) NOT NULL,
  synced_at datetimeoffset(3) NOT NULL CONSTRAINT device_syncs_synced_df DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT device_syncs_pk PRIMARY KEY (project_id, user_id, device_id)
);
--> statement-breakpoint
CREATE SECURITY POLICY rls.device_syncs_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.device_syncs,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.device_syncs AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.device_syncs AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.device_syncs TO wansurvey_app;
