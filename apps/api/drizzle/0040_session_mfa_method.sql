-- How a session's second factor was verified: 'totp' (a code entered in this browser) or
-- 'entra' (Microsoft performed MFA); null when none was. A session that needed none is 'ok'
-- too, so switching organisation carries a second factor over only by this.
ALTER TABLE sessions ADD COLUMN mfa_method text;
