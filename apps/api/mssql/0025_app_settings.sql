-- Settings of the installation as a whole (not of one organisation), such as how often the analysis
-- model is refreshed. The application reaches the table only through the two procedures below,
-- which run as the owner; it has no grant on the table.
CREATE TABLE dbo.app_settings (
  [key] nvarchar(100) NOT NULL CONSTRAINT app_settings_pk PRIMARY KEY,
  [value] nvarchar(max) NULL,
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT app_settings_updated_df DEFAULT SYSDATETIMEOFFSET(),
  updated_by uniqueidentifier NULL
);
--> statement-breakpoint
CREATE PROCEDURE dbo.app_setting_get @key nvarchar(100)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT [value], updated_at, updated_by FROM dbo.app_settings WHERE [key] = @key;
END;
--> statement-breakpoint
CREATE PROCEDURE dbo.app_setting_set @key nvarchar(100), @value nvarchar(max), @by uniqueidentifier
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  IF @value IS NULL
    DELETE FROM dbo.app_settings WHERE [key] = @key;
  ELSE IF EXISTS (SELECT 1 FROM dbo.app_settings WHERE [key] = @key)
    UPDATE dbo.app_settings SET [value] = @value, updated_at = SYSDATETIMEOFFSET(), updated_by = @by WHERE [key] = @key;
  ELSE
    INSERT INTO dbo.app_settings ([key], [value], updated_by) VALUES (@key, @value, @by);
END;
--> statement-breakpoint
GRANT EXECUTE ON dbo.app_setting_get TO wansurvey_app;
--> statement-breakpoint
GRANT EXECUTE ON dbo.app_setting_set TO wansurvey_app;
