-- The organisation's regional format (BCP 47, e.g. es-PE, en-GB): how dates, times and numbers
-- are written in the app, in the respondent's form and in readable exports, apart from the
-- language of the interface. NULL follows the language, as before.
ALTER TABLE dbo.tenants ADD format_locale nvarchar(35) NULL;
