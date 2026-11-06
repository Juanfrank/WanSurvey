-- The dimensions that read the organisation's own tables (organisations, projects, instruments,
-- versions, cases, people, the calendar) were views. A view runs the row-level security of
-- whoever reads it, so a read-only analysis user (GRANT SELECT ON SCHEMA::bi) saw no rows in them
-- and a join through them (the exported SQL does) came back empty. They are tables now, filled by
-- an owner procedure like the rest of the model; the former views stay as their sources, named
-- fuente_*, and nobody is meant to read them.
--
-- If a later migration changes what a dimension holds, it changes the fuente_ view and the table.

--> statement-breakpoint
EXEC sp_rename N'bi.dim_organizacion', N'fuente_dim_organizacion', N'OBJECT';
--> statement-breakpoint
EXEC sp_rename N'bi.dim_proyecto', N'fuente_dim_proyecto', N'OBJECT';
--> statement-breakpoint
EXEC sp_rename N'bi.dim_instrumento', N'fuente_dim_instrumento', N'OBJECT';
--> statement-breakpoint
EXEC sp_rename N'bi.dim_version', N'fuente_dim_version', N'OBJECT';
--> statement-breakpoint
EXEC sp_rename N'bi.dim_caso', N'fuente_dim_caso', N'OBJECT';
--> statement-breakpoint
EXEC sp_rename N'bi.dim_persona', N'fuente_dim_persona', N'OBJECT';
--> statement-breakpoint
EXEC sp_rename N'bi.dim_fecha', N'fuente_dim_fecha', N'OBJECT';
--> statement-breakpoint
SELECT * INTO bi.dim_organizacion FROM bi.fuente_dim_organizacion WHERE 1 = 0;
--> statement-breakpoint
SELECT * INTO bi.dim_proyecto FROM bi.fuente_dim_proyecto WHERE 1 = 0;
--> statement-breakpoint
SELECT * INTO bi.dim_instrumento FROM bi.fuente_dim_instrumento WHERE 1 = 0;
--> statement-breakpoint
SELECT * INTO bi.dim_version FROM bi.fuente_dim_version WHERE 1 = 0;
--> statement-breakpoint
SELECT * INTO bi.dim_caso FROM bi.fuente_dim_caso WHERE 1 = 0;
--> statement-breakpoint
SELECT * INTO bi.dim_persona FROM bi.fuente_dim_persona WHERE 1 = 0;
--> statement-breakpoint
SELECT * INTO bi.dim_fecha FROM bi.fuente_dim_fecha WHERE 1 = 0;
--> statement-breakpoint
CREATE INDEX dim_organizacion_ix ON bi.dim_organizacion (organizacion_id);
--> statement-breakpoint
CREATE INDEX dim_proyecto_ix ON bi.dim_proyecto (proyecto_id);
--> statement-breakpoint
CREATE INDEX dim_instrumento_ix ON bi.dim_instrumento (instrumento_id);
--> statement-breakpoint
CREATE INDEX dim_version_ix ON bi.dim_version (version_id);
--> statement-breakpoint
CREATE INDEX dim_caso_ix ON bi.dim_caso (caso_id);
--> statement-breakpoint
CREATE INDEX dim_persona_ix ON bi.dim_persona (persona_id, organizacion_id);
--> statement-breakpoint
CREATE INDEX dim_fecha_ix ON bi.dim_fecha (fecha);
--> statement-breakpoint
-- Refills the seven dimensions in one transaction (a refresh runs at a time, as for the other tables).
CREATE PROCEDURE bi.refrescar_dimensiones
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  DECLARE @lock int;
  BEGIN TRANSACTION;
  EXEC @lock = sp_getapplock @Resource = N'bi_refresh', @LockMode = N'Exclusive',
    @LockOwner = N'Transaction', @LockTimeout = 600000;
  IF @lock < 0 THROW 50011, 'Another refresh of the analysis model is running', 1;
  DELETE FROM bi.dim_organizacion;
  INSERT INTO bi.dim_organizacion SELECT * FROM bi.fuente_dim_organizacion;
  DELETE FROM bi.dim_proyecto;
  INSERT INTO bi.dim_proyecto SELECT * FROM bi.fuente_dim_proyecto;
  DELETE FROM bi.dim_instrumento;
  INSERT INTO bi.dim_instrumento SELECT * FROM bi.fuente_dim_instrumento;
  DELETE FROM bi.dim_version;
  INSERT INTO bi.dim_version SELECT * FROM bi.fuente_dim_version;
  DELETE FROM bi.dim_caso;
  INSERT INTO bi.dim_caso SELECT * FROM bi.fuente_dim_caso;
  DELETE FROM bi.dim_persona;
  INSERT INTO bi.dim_persona SELECT * FROM bi.fuente_dim_persona;
  DELETE FROM bi.dim_fecha;
  INSERT INTO bi.dim_fecha SELECT * FROM bi.fuente_dim_fecha;
  COMMIT;
END;
--> statement-breakpoint
GRANT EXECUTE ON bi.refrescar_dimensiones TO wansurvey_app;
--> statement-breakpoint
-- A fingerprint of everything the model reads, now with the sources of the dimensions.
ALTER PROCEDURE bi.estado_actual
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SELECT
    CONCAT_WS(N'|',
      (SELECT CONCAT(COUNT_BIG(*), N':', CONVERT(varchar(40), MAX(updated_at), 127)) FROM dbo.interviews),
      (SELECT CONCAT(COUNT_BIG(*), N':', CONVERT(varchar(40), MAX(created_at), 127)) FROM dbo.feedback_responses),
      (SELECT COUNT_BIG(*) FROM dbo.interview_paradata),
      (SELECT CONCAT(COUNT_BIG(*), N':', CONVERT(varchar(40), MAX(published_at), 127)) FROM dbo.questionnaire_versions),
      (SELECT CONCAT(COUNT_BIG(*), N':', CONVERT(varchar(40), MAX(updated_at), 127)) FROM dbo.feedback_points),
      (SELECT CONCAT(COUNT_BIG(*), N':', CONVERT(varchar(40), MAX(updated_at), 127)) FROM dbo.questionnaires),
      (SELECT CONCAT(COUNT_BIG(*), N':', CONVERT(varchar(40), MAX(updated_at), 127)) FROM dbo.cases),
      (SELECT CONCAT(COUNT_BIG(*), N':', CHECKSUM_AGG(BINARY_CHECKSUM(*))) FROM dbo.tenants),
      (SELECT CONCAT(COUNT_BIG(*), N':', CHECKSUM_AGG(BINARY_CHECKSUM(*))) FROM dbo.projects),
      (SELECT CONCAT(COUNT_BIG(*), N':', CHECKSUM_AGG(BINARY_CHECKSUM(*))) FROM dbo.users),
      (SELECT CONCAT(COUNT_BIG(*), N':', CHECKSUM_AGG(BINARY_CHECKSUM(*))) FROM dbo.tenant_members),
      (SELECT CONCAT(COUNT_BIG(*), N':', CHECKSUM_AGG(BINARY_CHECKSUM(*))) FROM dbo.teams),
      (SELECT COUNT_BIG(*) FROM dbo.team_members)) AS actual,
    (SELECT valor FROM bi.estado WHERE clave = N'huella') AS ultima;
END;
--> statement-breakpoint
-- Everything at once, by hand (EXEC bi.refrescar;): the dimensions, then the tables in the order
-- they depend on each other, one transaction each.
ALTER PROCEDURE bi.refrescar
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @h nvarchar(450) = (SELECT TOP 1 actual FROM (
    SELECT CONCAT_WS(N'|',
      (SELECT CONCAT(COUNT_BIG(*), N':', CONVERT(varchar(40), MAX(updated_at), 127)) FROM dbo.interviews),
      (SELECT CONCAT(COUNT_BIG(*), N':', CONVERT(varchar(40), MAX(created_at), 127)) FROM dbo.feedback_responses),
      (SELECT COUNT_BIG(*) FROM dbo.interview_paradata),
      (SELECT CONCAT(COUNT_BIG(*), N':', CONVERT(varchar(40), MAX(published_at), 127)) FROM dbo.questionnaire_versions),
      (SELECT CONCAT(COUNT_BIG(*), N':', CONVERT(varchar(40), MAX(updated_at), 127)) FROM dbo.feedback_points),
      (SELECT CONCAT(COUNT_BIG(*), N':', CONVERT(varchar(40), MAX(updated_at), 127)) FROM dbo.questionnaires),
      (SELECT CONCAT(COUNT_BIG(*), N':', CONVERT(varchar(40), MAX(updated_at), 127)) FROM dbo.cases),
      (SELECT CONCAT(COUNT_BIG(*), N':', CHECKSUM_AGG(BINARY_CHECKSUM(*))) FROM dbo.tenants),
      (SELECT CONCAT(COUNT_BIG(*), N':', CHECKSUM_AGG(BINARY_CHECKSUM(*))) FROM dbo.projects),
      (SELECT CONCAT(COUNT_BIG(*), N':', CHECKSUM_AGG(BINARY_CHECKSUM(*))) FROM dbo.users),
      (SELECT CONCAT(COUNT_BIG(*), N':', CHECKSUM_AGG(BINARY_CHECKSUM(*))) FROM dbo.tenant_members),
      (SELECT CONCAT(COUNT_BIG(*), N':', CHECKSUM_AGG(BINARY_CHECKSUM(*))) FROM dbo.teams),
      (SELECT COUNT_BIG(*) FROM dbo.team_members)) AS actual) t);
  EXEC bi.refrescar_dimensiones;
  DECLARE @t TABLE (n int IDENTITY, v nvarchar(64));
  INSERT INTO @t (v) VALUES (N'preguntas_fuente'), (N'dim_pregunta'), (N'dim_opcion'), (N'dim_fila'),
    (N'fact_envio'), (N'fact_respuesta'), (N'fact_paradato'), (N'plano_respuestas');
  DECLARE @i int = 1, @name nvarchar(64);
  WHILE @i <= 8
  BEGIN
    SELECT @name = v FROM @t WHERE n = @i;
    BEGIN TRANSACTION;
    EXEC bi.refrescar_vista @name;
    COMMIT;
    SET @i += 1;
  END;
  EXEC bi.marcar_huella @h;
END;
--> statement-breakpoint
EXEC bi.refrescar_dimensiones;
