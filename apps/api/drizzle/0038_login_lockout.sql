-- Per-account lockout after repeated failed sign-ins or codes, and one use per TOTP code.
ALTER TABLE users ADD COLUMN failed_logins integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN locked_until timestamptz;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN totp_last_step bigint;
--> statement-breakpoint
-- Before the password is checked: until when the account is locked (null: it is not).
CREATE FUNCTION account_locked_until(p_user_id uuid) RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT u.locked_until FROM users u WHERE u.id = p_user_id AND u.locked_until > now() $$;
--> statement-breakpoint
-- A failed password or code: the count goes up, and at p_max the account locks for a while
-- (the count starts again after it). Returns the lock's end, or null.
CREATE FUNCTION account_failed(p_user_id uuid, p_max integer, p_lock_seconds integer)
  RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $$
    DECLARE until timestamptz;
    BEGIN
      UPDATE users SET
        failed_logins = CASE WHEN failed_logins + 1 >= p_max THEN 0 ELSE failed_logins + 1 END,
        locked_until = CASE WHEN failed_logins + 1 >= p_max
                            THEN now() + make_interval(secs => p_lock_seconds) ELSE locked_until END
      WHERE id = p_user_id
      RETURNING CASE WHEN locked_until > now() THEN locked_until END INTO until;
      RETURN until;
    END
  $$;
--> statement-breakpoint
CREATE FUNCTION account_succeeded(p_user_id uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public
  AS $$ UPDATE users SET failed_logins = 0, locked_until = NULL
        WHERE id = p_user_id AND (failed_logins <> 0 OR locked_until IS NOT NULL) $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['account_locked_until(uuid)', 'account_failed(uuid, integer, integer)', 'account_succeeded(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO wansurvey_app', f);
  END LOOP;
END $$;
