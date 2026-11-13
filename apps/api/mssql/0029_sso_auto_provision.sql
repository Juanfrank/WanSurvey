-- Whether each organisation creates the account of whoever first signs in with Microsoft from one
-- of its domains (a member with no role), or only lets in people an administrator added.
ALTER TABLE dbo.tenant_sso ADD auto_provision bit NOT NULL CONSTRAINT tsso_autoprov_df DEFAULT 1;
