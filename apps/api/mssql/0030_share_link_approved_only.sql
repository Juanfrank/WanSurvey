-- A link for clients can be fixed to approved interviews only: the summary it opens leaves out
-- the interviews not yet reviewed, whatever its address asks.
ALTER TABLE dbo.share_links ADD approved_only bit NOT NULL CONSTRAINT slinks_approved_df DEFAULT 0;
