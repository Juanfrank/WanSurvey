-- Acceptance of the terms of use and the confidentiality undertaking, by each person who works in
-- the application: which version of the text and when. A new version asks everyone again.
ALTER TABLE dbo.users ADD terms_version int NULL;
--> statement-breakpoint
ALTER TABLE dbo.users ADD terms_accepted_at datetimeoffset(3) NULL;
