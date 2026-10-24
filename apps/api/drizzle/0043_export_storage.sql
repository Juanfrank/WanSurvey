-- Export files are written to storage as they are built (Blob Storage, or a directory in
-- development) and named here; `file` keeps the files of exports made before.
ALTER TABLE exports ADD COLUMN storage_key text;
