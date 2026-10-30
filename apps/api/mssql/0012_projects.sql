-- Projects as PostgreSQL has them after drizzle/0007 (settings) and 0011 (Spanish by default).
ALTER TABLE projects ADD settings nvarchar(max) NOT NULL
  CONSTRAINT projects_settings_df DEFAULT '{}'
  CONSTRAINT projects_settings_json CHECK (ISJSON(settings) = 1);
--> statement-breakpoint
ALTER TABLE projects DROP CONSTRAINT projects_languages_df;
--> statement-breakpoint
ALTER TABLE projects ADD CONSTRAINT projects_languages_df DEFAULT '["es"]' FOR languages;
