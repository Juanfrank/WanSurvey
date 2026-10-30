-- Answer review on SQL Server, the counterpart of drizzle/0016: reviewers' comments on an
-- interview, the codes defined for the free text of "other, specify" answers, and the code each
-- distinct text was given. Coding is by project, variable and text, so those columns are bounded
-- (200 and 450 characters) to keep the unique index under SQL Server's 1700-byte key limit.
CREATE TABLE review_comments (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT rcomments_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  interview_id uniqueidentifier NOT NULL CONSTRAINT rcomments_interview_fk FOREIGN KEY REFERENCES interviews (id),
  -- The answer key commented on; null for the whole interview.
  variable nvarchar(450) NULL,
  body nvarchar(max) NOT NULL,
  author_id uniqueidentifier NOT NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT rcomments_created_df DEFAULT SYSDATETIMEOFFSET(),
  resolved_at datetimeoffset(3) NULL
);
--> statement-breakpoint
CREATE INDEX review_comments_interview_idx ON review_comments (interview_id, created_at);
--> statement-breakpoint
CREATE TABLE open_codes (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT ocodes_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT ocodes_project_fk FOREIGN KEY REFERENCES projects (id),
  -- The text variable, e.g. A6_OCC_OTHER.
  variable nvarchar(200) NOT NULL,
  code int NOT NULL,
  label nvarchar(450) NOT NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT ocodes_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX open_codes_uq ON open_codes (project_id, variable, code);
--> statement-breakpoint
CREATE TABLE coded_texts (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT ctexts_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  project_id uniqueidentifier NOT NULL CONSTRAINT ctexts_project_fk FOREIGN KEY REFERENCES projects (id),
  variable nvarchar(200) NOT NULL,
  -- Trimmed and lower-cased, so the same text written differently gets one code. The unique
  -- index below compares it case-insensitively too (the column is CI, as the database is).
  text nvarchar(450) COLLATE Latin1_General_100_CI_AS NOT NULL,
  code int NOT NULL,
  coded_by uniqueidentifier NULL,
  coded_at datetimeoffset(3) NOT NULL CONSTRAINT ctexts_coded_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX coded_texts_uq ON coded_texts (project_id, variable, text);
--> statement-breakpoint
CREATE SECURITY POLICY rls.review_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.review_comments,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.review_comments AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.review_comments AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.open_codes,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.open_codes AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.open_codes AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.coded_texts,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.coded_texts AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.coded_texts AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dbo.review_comments TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.open_codes TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.coded_texts TO wansurvey_app;
