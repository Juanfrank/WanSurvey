-- SMS invitations (ADR 0001, decision 4): the invitation's address is an E.164 number for a wave
-- whose channel is 'sms' (the column is `email`, the address of the invitation). When a person
-- replies STOP the provider tells the application only the number, so this finds the
-- organisations that wrote to it, before any organisation is known.
CREATE INDEX invitations_address_idx ON invitations (email);
--> statement-breakpoint
CREATE PROCEDURE dbo.tenants_invited_at @address nvarchar(450)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT DISTINCT tenant_id FROM dbo.invitations WHERE email = @address;
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.tenants_invited_at TO wansurvey_app;
