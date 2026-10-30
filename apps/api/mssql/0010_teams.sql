-- Teams of people in the organisation (field crews, call-centre shifts), each with a leader:
-- the counterpart of drizzle/0029_teams.sql. Also gives the analysis model's people their teams.
CREATE TABLE teams (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  tenant_id uniqueidentifier NOT NULL CONSTRAINT teams_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  name nvarchar(450) NOT NULL,
  leader_user_id uniqueidentifier NULL CONSTRAINT teams_leader_fk FOREIGN KEY REFERENCES users (id),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT teams_created_df DEFAULT SYSDATETIMEOFFSET()
);
--> statement-breakpoint
CREATE UNIQUE INDEX teams_name_uq ON teams (tenant_id, name);
--> statement-breakpoint
CREATE TABLE team_members (
  team_id uniqueidentifier NOT NULL CONSTRAINT team_members_team_fk FOREIGN KEY REFERENCES teams (id) ON DELETE CASCADE,
  user_id uniqueidentifier NOT NULL CONSTRAINT team_members_user_fk FOREIGN KEY REFERENCES users (id),
  tenant_id uniqueidentifier NOT NULL CONSTRAINT team_members_tenant_fk FOREIGN KEY REFERENCES tenants (id),
  CONSTRAINT team_members_pk PRIMARY KEY (team_id, user_id)
);
--> statement-breakpoint
CREATE INDEX team_members_user_idx ON team_members (user_id);
--> statement-breakpoint
CREATE SECURITY POLICY rls.teams_isolation
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.teams,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.teams AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.teams AFTER UPDATE,
  ADD FILTER PREDICATE rls.tenant_predicate(tenant_id) ON dbo.team_members,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.team_members AFTER INSERT,
  ADD BLOCK PREDICATE rls.tenant_predicate(tenant_id) ON dbo.team_members AFTER UPDATE
  WITH (STATE = ON, SCHEMABINDING = ON);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.teams TO wansurvey_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.team_members TO wansurvey_app;
--> statement-breakpoint
ALTER VIEW bi.dim_persona AS
SELECT u.id AS persona_id, u.name AS persona,
       CAST((SELECT STRING_AGG(t.name, N', ') WITHIN GROUP (ORDER BY t.name)
             FROM dbo.team_members m JOIN dbo.teams t ON t.id = m.team_id
             WHERE m.user_id = u.id AND t.tenant_id = tm.tenant_id) AS nvarchar(max)) AS equipos,
       tm.tenant_id AS organizacion_id
FROM dbo.users u
JOIN (SELECT DISTINCT tenant_id, user_id FROM dbo.memberships) tm ON tm.user_id = u.id;
