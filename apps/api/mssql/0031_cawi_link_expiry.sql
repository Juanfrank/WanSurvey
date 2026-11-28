-- Personal web links can expire and be revoked one by one: an outreach may give its links an
-- end date, each link may get its own, and a link handed to the wrong person can be withdrawn.
ALTER TABLE dbo.waves ADD links_expire_at datetimeoffset(3) NULL;
--> statement-breakpoint
ALTER TABLE dbo.invitations ADD
  expires_at datetimeoffset(3) NULL,
  revoked_at datetimeoffset(3) NULL,
  revoked_by uniqueidentifier NULL;
