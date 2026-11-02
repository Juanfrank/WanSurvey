-- Keys for the integration API (/api/v1/ext, ADR 0001). Only the SHA-256 of the secret is kept; the
-- key id is the part before it in `wsk_<id>_<secret>` and is how a request finds its key.
CREATE TABLE api_keys (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT api_keys_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  key_id nvarchar(32) NOT NULL,
  secret_hash char(64) NOT NULL,
  name nvarchar(200) NOT NULL,
  scopes nvarchar(max) NOT NULL,
  project_id uniqueidentifier NULL CONSTRAINT api_keys_project_fk FOREIGN KEY REFERENCES projects (id),
  allowed_ips nvarchar(max) NULL,
  expires_at datetimeoffset(3) NOT NULL,
  created_by uniqueidentifier NOT NULL CONSTRAINT api_keys_creator_fk FOREIGN KEY REFERENCES users (id),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT api_keys_created_df DEFAULT SYSDATETIMEOFFSET(),
  last_used_at datetimeoffset(3) NULL,
  revoked_at datetimeoffset(3) NULL,
  revoked_by uniqueidentifier NULL CONSTRAINT api_keys_revoker_fk FOREIGN KEY REFERENCES users (id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX api_keys_key_id_uq ON api_keys (key_id);
--> statement-breakpoint
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id, created_at);
--> statement-breakpoint
CREATE SECURITY POLICY rls.api_keys_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.api_keys,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.api_keys AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.api_keys AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.api_keys TO wansurvey_app;
--> statement-breakpoint
-- The key a request presents, before any organisation is known (an owner procedure, like the
-- sign-in lookups): the caller then checks the secret, expiry, revocation and address.
CREATE PROCEDURE dbo.api_key_lookup @key_id nvarchar(32)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT id, tenant_id, secret_hash, scopes, project_id, allowed_ips, expires_at, created_by, revoked_at
  FROM dbo.api_keys WHERE key_id = @key_id;
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.api_key_lookup TO wansurvey_app;
