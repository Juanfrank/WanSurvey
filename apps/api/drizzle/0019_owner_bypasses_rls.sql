-- Managed Postgres (Azure Flexible Server, RDS…) has no superuser: migrations, seeds and the
-- security-definer functions run as the database owner, which FORCE ROW LEVEL SECURITY would
-- filter like anyone else (login lookups, e-mail dispatch and nightly jobs would see no rows).
-- Isolation never relied on FORCE: the application connects as `wansurvey_app`, which owns
-- nothing and is not exempt, so every one of its queries stays filtered by tenant.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
