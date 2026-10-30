-- Who a live one-time token (invitation, password reset) belongs to, before any organisation or
-- person is known: the link carries only the token. An owner procedure, like the sign-in lookups.
CREATE PROCEDURE dbo.peek_user_token @token_hash nvarchar(450), @purpose nvarchar(64)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT user_id, tenant_id
  FROM dbo.user_tokens
  WHERE token_hash = @token_hash AND purpose = @purpose
    AND used_at IS NULL AND expires_at > SYSDATETIMEOFFSET();
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.peek_user_token TO wansurvey_app;
--> statement-breakpoint
-- The account an external identity (Microsoft) is linked to, in any organisation: the first
-- sign-in must know whether it is linked elsewhere before it is a member here.
CREATE PROCEDURE dbo.user_by_identity @issuer nvarchar(450), @subject nvarchar(450)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT user_id FROM dbo.user_identities WHERE issuer = @issuer AND subject = @subject;
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.user_by_identity TO wansurvey_app;
