-- The organisation's logo: shown in the side panel (as the main logo or beside WanSurvey's, as
-- its theme says) and, in single-tenant mode, on the sign-in page. Its description (alt text) and
-- when it changed are on the organisation, so /auth/me can say how to draw it without reading the
-- image; the image itself (PNG, JPEG or WebP, checked by its bytes) is in a table of its own, as
-- the project logos are.
ALTER TABLE dbo.tenants ADD logo_alt nvarchar(200) NULL, logo_updated_at datetimeoffset(3) NULL;
--> statement-breakpoint
CREATE TABLE dbo.tenant_logos (
  tenant_id uniqueidentifier NOT NULL CONSTRAINT pk_tenant_logos PRIMARY KEY CONSTRAINT tlogos_tenant_fk FOREIGN KEY REFERENCES dbo.tenants (id),
  content_type nvarchar(100) NOT NULL,
  image varbinary(max) NOT NULL,
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT tlogos_updated_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE SECURITY POLICY rls.tenant_logos_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.tenant_logos,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.tenant_logos AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.tenant_logos AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.tenant_logos TO wansurvey_app;
