-- The reason an interview was closed early (0023) in the analysis model: a column of the facts of
-- sendings and of the flat table. The procedure is the one of 0009 with that column added
-- (CREATE OR ALTER keeps its permissions).
ALTER TABLE bi.fact_envio ADD motivo_salida nvarchar(64) NULL;
--> statement-breakpoint
CREATE OR ALTER PROCEDURE bi.refrescar_vista @v nvarchar(64)
  WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  IF @v NOT IN (N'preguntas_fuente', N'dim_pregunta', N'dim_opcion', N'dim_fila', N'fact_envio',
                N'fact_respuesta', N'fact_paradato', N'plano_respuestas')
    THROW 50010, 'Not a table of the analysis model', 1;
  DECLARE @lock int;
  EXEC @lock = sp_getapplock @Resource = N'bi_refresh', @LockMode = N'Exclusive',
    @LockOwner = N'Transaction', @LockTimeout = 600000;
  IF @lock < 0 THROW 50011, 'Another refresh of the analysis model is running', 1;

  IF @v = N'preguntas_fuente'
  BEGIN
    DELETE FROM bi.preguntas_fuente;
    ;WITH nodos AS (
      SELECT v.id AS version_id,
             CAST(JSON_VALUE(v.compiled, '$.questionnaire.defaultLanguage') AS nvarchar(32)) AS lang,
             CAST(s.[value] AS nvarchar(max)) AS nodo,
             CAST(RIGHT(N'00000' + s.[key], 5) AS nvarchar(900)) AS ruta
      FROM dbo.questionnaire_versions v
      CROSS APPLY OPENJSON(v.compiled, '$.questionnaire.sections') s
      UNION ALL
      SELECT n.version_id, n.lang, CAST(c.[value] AS nvarchar(max)),
             CAST(n.ruta + N'.' + RIGHT(N'00000' + c.[key], 5) AS nvarchar(900))
      FROM nodos n CROSS APPLY OPENJSON(CASE WHEN ISJSON(n.nodo) = 1 THEN n.nodo ELSE N'{}' END, '$.items') c
    )
    INSERT INTO bi.preguntas_fuente (version_id, lang, variable, q, orden)
    SELECT version_id, lang, nombre, nodo,
           ROW_NUMBER() OVER (PARTITION BY version_id ORDER BY ruta)
    FROM (
      SELECT version_id, lang, nodo, ruta,
             CASE WHEN ISJSON(nodo) = 1 THEN JSON_VALUE(nodo, '$.name') END AS nombre,
             CASE WHEN ISJSON(nodo) = 1 THEN JSON_VALUE(nodo, '$.kind') END AS kind
      FROM nodos
    ) n
    WHERE kind = 'question' AND nombre IS NOT NULL
    OPTION (MAXRECURSION 0);
  END

  ELSE IF @v = N'dim_pregunta'
  BEGIN
    DELETE FROM bi.dim_pregunta;
    SELECT v.id AS version_id, x.[key] COLLATE DATABASE_DEFAULT AS variable, x.[value] COLLATE DATABASE_DEFAULT AS def
    INTO #vars
    FROM dbo.questionnaire_versions v CROSS APPLY OPENJSON(v.compiled, '$.vars') x;
    SELECT t.version_id, t.variable,
           (SELECT STRING_AGG(r.[value] COLLATE DATABASE_DEFAULT, N'.') WITHIN GROUP (ORDER BY CAST(r.[key] AS int))
            FROM OPENJSON(t.def, '$.rosterChain') r) AS cadena,
           (SELECT TOP 1 r.[value] COLLATE DATABASE_DEFAULT FROM OPENJSON(t.def, '$.rosterChain') r
            ORDER BY CAST(r.[key] AS int) DESC) AS lista,
           JSON_VALUE(t.def, '$.kind') AS kind, JSON_VALUE(t.def, '$.type') AS tipo
    INTO #cadenas
    FROM #vars t;

    SELECT version_id, variable, tipo, clase, pregunta_i18n, lang, cadena, lista, orden, personal
    INTO #p
    FROM (
      SELECT f.version_id, f.variable, CAST(JSON_VALUE(f.q, '$.type') AS nvarchar(64)) AS tipo,
             CAST(N'pregunta' AS nvarchar(32)) AS clase,
             CAST(JSON_QUERY(f.q, '$.text') AS nvarchar(max)) AS pregunta_i18n, f.lang,
             CAST(c.cadena AS nvarchar(450)) AS cadena, CAST(c.lista AS nvarchar(450)) AS lista,
             f.orden, CAST(CASE WHEN JSON_VALUE(f.q, '$.personal') = 'true' THEN 1 ELSE 0 END AS bit) AS personal
      FROM bi.preguntas_fuente f
      LEFT JOIN #cadenas c ON c.version_id = f.version_id
        AND c.variable COLLATE Latin1_General_100_BIN2 = f.variable COLLATE Latin1_General_100_BIN2
      UNION ALL
      SELECT c.version_id, c.variable, c.tipo, c.kind, NULL,
             CAST(JSON_VALUE(v.compiled, '$.questionnaire.defaultLanguage') AS nvarchar(32)),
             c.cadena, c.lista, 100000, 0
      FROM #cadenas c JOIN dbo.questionnaire_versions v ON v.id = c.version_id
      WHERE c.kind IN ('computed', 'other')
      UNION ALL
      SELECT id, '_CARA', 'faces', 'valoracion', question, 'es', N'', NULL, 0, 0 FROM dbo.feedback_points
      UNION ALL
      SELECT id, '_COMENTARIO', 'text', 'valoracion', N'{"es": "Comentario"}', 'es', N'', NULL, 1000, 0
      FROM dbo.feedback_points
      UNION ALL
      SELECT p.id, JSON_VALUE(it.[value] COLLATE DATABASE_DEFAULT, '$.id'), JSON_VALUE(it.[value] COLLATE DATABASE_DEFAULT, '$.type'), 'valoracion',
             JSON_QUERY(it.[value] COLLATE DATABASE_DEFAULT, '$.text'), 'es', N'', NULL, 2 + CAST(it.[key] AS int), 0
      FROM dbo.feedback_points p CROSS APPLY OPENJSON(p.items) it
    ) u;

    INSERT INTO bi.dim_pregunta (pregunta_id, version_id, variable, tipo, clase, pregunta,
                                 pregunta_i18n, lista, cadena, orden, personal)
    SELECT bi.clave(CONCAT(LOWER(CONVERT(varchar(36), version_id)), N'|', variable)), version_id, variable,
           tipo, clase, bi.plano(bi.texto(pregunta_i18n, lang)), pregunta_i18n,
           NULLIF(lista, N''), NULLIF(cadena, N''), orden, personal
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY version_id, variable COLLATE Latin1_General_100_BIN2
                                   ORDER BY orden) AS rn
      FROM #p
    ) x
    WHERE rn = 1;
    DROP TABLE #p; DROP TABLE #cadenas; DROP TABLE #vars;
  END

  ELSE IF @v = N'dim_opcion'
  BEGIN
    DELETE FROM bi.dim_opcion;
    SELECT v.id AS version_id, x.[key] COLLATE DATABASE_DEFAULT AS id, x.[value] COLLATE DATABASE_DEFAULT AS opciones
    INTO #sets
    FROM dbo.questionnaire_versions v CROSS APPLY OPENJSON(v.compiled, '$.questionnaire.answerSets') x;
    SELECT v.id AS version_id, x.[key] COLLATE DATABASE_DEFAULT AS clase, x.[value] COLLATE DATABASE_DEFAULT AS def
    INTO #especiales
    FROM dbo.questionnaire_versions v
    CROSS APPLY OPENJSON(v.compiled, '$.questionnaire.settings.specialCodes') x;

    CREATE TABLE #o (version_id uniqueidentifier, variable nvarchar(450), codigo nvarchar(450),
                     etiqueta_i18n nvarchar(max), lang nvarchar(32), especial bit, orden bigint);

    -- Own options, the shared answer set, or yes/no.
    INSERT INTO #o
    SELECT f.version_id, f.variable, JSON_VALUE(o.[value], '$.code'), JSON_QUERY(o.[value], '$.label'),
           f.lang, 0, CAST(o.[key] AS int) + 1
    FROM bi.preguntas_fuente f
    OUTER APPLY (SELECT s.opciones FROM #sets s
                 WHERE s.version_id = f.version_id
                   AND s.id COLLATE Latin1_General_100_BIN2 = JSON_VALUE(f.q, '$.answerSetId') COLLATE Latin1_General_100_BIN2) aset
    CROSS APPLY OPENJSON(CASE
      WHEN EXISTS (SELECT 1 FROM OPENJSON(f.q, '$.options')) THEN JSON_QUERY(f.q, '$.options')
      WHEN aset.opciones IS NOT NULL THEN aset.opciones
      WHEN JSON_VALUE(f.q, '$.type') = 'yesno'
        THEN N'[{"code": 1, "label": {"en": "Yes", "es": "Sí"}}, {"code": 2, "label": {"en": "No", "es": "No"}}]'
      ELSE N'[]' END) o;

    -- Likert and NPS points (not sliders, whole steps, at most 11 points).
    ;WITH e AS (
      SELECT f.version_id, f.variable, f.lang, f.q,
             CAST(TRY_CAST(JSON_VALUE(f.q, '$.scale.min') AS float) AS int) AS lo,
             CAST(TRY_CAST(JSON_VALUE(f.q, '$.scale.max') AS float) AS int) AS hi,
             CAST(ISNULL(TRY_CAST(JSON_VALUE(f.q, '$.scale.step') AS float), 1) AS int) AS paso,
             ISNULL(TRY_CAST(JSON_VALUE(f.q, '$.scale.step') AS float), 1) AS paso_real
      FROM bi.preguntas_fuente f
      WHERE JSON_VALUE(f.q, '$.type') = 'scale' AND JSON_VALUE(f.q, '$.scale.style') <> 'slider'
    )
    INSERT INTO #o
    SELECT e.version_id, e.variable, CAST(p.p AS nvarchar(450)),
      CASE
        WHEN p.p = e.lo AND JSON_QUERY(e.q, '$.scale.minLabel') IS NOT NULL THEN
          REPLACE((SELECT N'{' + STRING_AGG(N'"' + STRING_ESCAPE(l.[key] COLLATE DATABASE_DEFAULT, 'json') + N'":"#P# – '
             + STRING_ESCAPE(bi.plano(l.[value] COLLATE DATABASE_DEFAULT), 'json') + N'"', N',') + N'}'
           FROM OPENJSON(e.q, '$.scale.minLabel') l), N'#P#', CAST(p.p AS nvarchar(20)))
        WHEN p.p = e.hi AND JSON_QUERY(e.q, '$.scale.maxLabel') IS NOT NULL THEN
          REPLACE((SELECT N'{' + STRING_AGG(N'"' + STRING_ESCAPE(l.[key] COLLATE DATABASE_DEFAULT, 'json') + N'":"#P# – '
             + STRING_ESCAPE(bi.plano(l.[value] COLLATE DATABASE_DEFAULT), 'json') + N'"', N',') + N'}'
           FROM OPENJSON(e.q, '$.scale.maxLabel') l), N'#P#', CAST(p.p AS nvarchar(20)))
        ELSE N'{"' + STRING_ESCAPE(ISNULL(e.lang, N'es'), 'json') + N'":"' + CAST(p.p AS nvarchar(20)) + N'"}'
      END,
      e.lang, 0, p.p
    FROM e
    CROSS APPLY (
      SELECT TOP (CASE WHEN e.paso > 0 AND e.paso = e.paso_real AND e.hi >= e.lo
                         AND (e.hi - e.lo) / e.paso < 11 THEN (e.hi - e.lo) / e.paso + 1 ELSE 0 END)
             e.lo + (ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1) * e.paso AS p
      FROM sys.all_columns
    ) p
    WHERE e.lo IS NOT NULL AND e.hi IS NOT NULL;

    -- Special codes (don't know, refused…).
    INSERT INTO #o
    SELECT f.version_id, f.variable, JSON_VALUE(sp.def, '$.code'), JSON_QUERY(sp.def, '$.label'),
           f.lang, 1, 1000
    FROM bi.preguntas_fuente f
    JOIN #especiales sp ON sp.version_id = f.version_id
    WHERE JSON_VALUE(f.q, '$.type') IN ('single', 'multi', 'yesno', 'numeric', 'grid', 'scale', 'ranking');

    -- The faces of feedback points, and the options of their follow-up questions.
    INSERT INTO #o
    SELECT fp.id, '_CARA', CAST(c.c AS nvarchar(450)),
      N'{"es":"' + CASE WHEN fp.faces = 5
        THEN CHOOSE(c.c, N'Muy mal', N'Mal', N'Regular', N'Bien', N'Muy bien')
        ELSE CHOOSE(c.c, N'Mal', N'Regular', N'Bien') END + N'"}',
      'es', 0, c.c
    FROM dbo.feedback_points fp
    CROSS APPLY (SELECT TOP (CASE WHEN fp.faces BETWEEN 1 AND 5 THEN fp.faces ELSE 0 END)
                        CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS int) AS c
                 FROM sys.all_columns) c;
    INSERT INTO #o
    SELECT fp.id, JSON_VALUE(it.[value], '$.id'), JSON_VALUE(o.[value], '$.code'),
           JSON_QUERY(o.[value], '$.label'), 'es', 0, CAST(o.[key] AS int) + 1
    FROM dbo.feedback_points fp
    CROSS APPLY OPENJSON(fp.items) it
    CROSS APPLY OPENJSON(CASE WHEN JSON_VALUE(it.[value], '$.type') = 'yesno'
      THEN N'[{"code": 1, "label": {"es": "Sí"}}, {"code": 2, "label": {"es": "No"}}]'
      ELSE ISNULL(JSON_QUERY(it.[value], '$.options'), N'[]') END) o;

    -- One option per version, variable and code; a real one wins over a special one.
    INSERT INTO bi.dim_opcion (opcion_id, pregunta_id, codigo, etiqueta, etiqueta_i18n, especial, orden)
    SELECT bi.clave(CONCAT(LOWER(CONVERT(varchar(36), version_id)), N'|', variable, N'|', codigo)),
           bi.clave(CONCAT(LOWER(CONVERT(varchar(36), version_id)), N'|', variable)),
           codigo, bi.plano(bi.texto(etiqueta_i18n, lang)), etiqueta_i18n, especial, orden
    FROM (
      SELECT *, ROW_NUMBER() OVER (
               PARTITION BY version_id, variable COLLATE Latin1_General_100_BIN2, codigo COLLATE Latin1_General_100_BIN2
               ORDER BY especial, orden) AS rn
      FROM #o WHERE codigo IS NOT NULL
    ) x
    WHERE rn = 1;
    DROP TABLE #o; DROP TABLE #sets; DROP TABLE #especiales;
  END

  ELSE IF @v = N'dim_fila'
  BEGIN
    DELETE FROM bi.dim_fila;
    INSERT INTO bi.dim_fila (fila_id, pregunta_id, fila_codigo, fila, fila_i18n, orden)
    SELECT bi.clave(CONCAT(LOWER(CONVERT(varchar(36), x.version_id)), N'|', x.variable, N'|', x.codigo)),
           bi.clave(CONCAT(LOWER(CONVERT(varchar(36), x.version_id)), N'|', x.variable)),
           x.codigo, bi.plano(bi.texto(x.label, x.lang)), x.label, x.n
    FROM (
      SELECT f.version_id, f.variable, f.lang, JSON_VALUE(r.[value], '$.code') AS codigo,
             JSON_QUERY(r.[value], '$.label') AS label, CAST(r.[key] AS int) + 1 AS n,
             ROW_NUMBER() OVER (PARTITION BY f.version_id, f.variable COLLATE Latin1_General_100_BIN2,
                                JSON_VALUE(r.[value], '$.code') COLLATE Latin1_General_100_BIN2
                                ORDER BY CAST(r.[key] AS int)) AS rn
      FROM bi.preguntas_fuente f CROSS APPLY OPENJSON(f.q, '$.rows') r
    ) x
    WHERE x.rn = 1 AND x.codigo IS NOT NULL;
  END

  ELSE IF @v = N'fact_envio'
  BEGIN
    DELETE FROM bi.fact_envio;
    INSERT INTO bi.fact_envio (envio_id, version_id, proyecto_id, caso_id, persona_id, canal, fecha,
      iniciado_en, enviado_en, estado, resultado, idioma, digitacion, en_muestra_revision,
      segundos_activos, segundos_totales, cara, referencia, completa, retrocesos, notas, pausas,
      advertencias, alertas, motivo_salida)
    SELECT i.id, i.questionnaire_version_id, i.project_id, i.case_id, i.interviewer_id, i.mode,
           CAST(DATEADD(minute, ISNULL(z.minutos, 0),
             CAST(SWITCHOFFSET(COALESCE(i.submitted_at, i.started_at), '+00:00') AS datetime2(3))) AS date),
           i.started_at, i.submitted_at, i.status, i.disposition, i.language, i.entry_pass, i.sampled,
           ROUND(i.active_ms / 1000.0, 0), ROUND(i.total_ms / 1000.0, 0), NULL, NULL,
           CASE WHEN i.disposition = 'COMPLETE' THEN 1 ELSE 0 END,
           ISNULL(pd.retrocesos, 0), ISNULL(pd.notas, 0), ISNULL(pd.pausas, 0), ISNULL(pd.advertencias, 0),
           (SELECT STRING_AGG(k.[key], N' ') WITHIN GROUP (ORDER BY k.[key] COLLATE Latin1_General_BIN2)
            FROM OPENJSON(i.flags) k),
           i.exit_reason
    FROM dbo.interviews i
    JOIN dbo.projects p ON p.id = i.project_id
    OUTER APPLY (SELECT TOP 1 zz.minutos FROM bi.zona zz
                 WHERE zz.tz = p.timezone
                   AND zz.desde <= CAST(SWITCHOFFSET(COALESCE(i.submitted_at, i.started_at), '+00:00') AS datetime2(0))
                 ORDER BY zz.desde DESC) z
    LEFT JOIN (
      SELECT interview_id,
             SUM(CASE WHEN type = 'navigate_back' THEN 1 ELSE 0 END) AS retrocesos,
             SUM(CASE WHEN type = 'note_added' THEN 1 ELSE 0 END) AS notas,
             SUM(CASE WHEN type = 'pause' THEN 1 ELSE 0 END) AS pausas,
             SUM(CASE WHEN type = 'warning_confirmed' THEN 1 ELSE 0 END) AS advertencias
      FROM dbo.interview_paradata GROUP BY interview_id
    ) pd ON pd.interview_id = i.id;

    INSERT INTO bi.fact_envio (envio_id, version_id, proyecto_id, caso_id, persona_id, canal, fecha,
      iniciado_en, enviado_en, estado, resultado, idioma, digitacion, en_muestra_revision,
      segundos_activos, segundos_totales, cara, referencia, completa, retrocesos, notas, pausas,
      advertencias, alertas, motivo_salida)
    SELECT r.id, r.point_id, f.project_id, NULL, NULL, r.channel,
           CAST(DATEADD(minute, ISNULL(z.minutos, 0),
             CAST(SWITCHOFFSET(r.created_at, '+00:00') AS datetime2(3))) AS date),
           r.created_at, r.created_at, 'submitted', 'COMPLETE', NULL, NULL, 0, NULL, NULL,
           r.score, r.ref, 1, 0, 0, 0, 0, NULL, NULL
    FROM dbo.feedback_responses r
    JOIN dbo.feedback_points f ON f.id = r.point_id
    JOIN dbo.projects p ON p.id = f.project_id
    OUTER APPLY (SELECT TOP 1 zz.minutos FROM bi.zona zz
                 WHERE zz.tz = p.timezone
                   AND zz.desde <= CAST(SWITCHOFFSET(r.created_at, '+00:00') AS datetime2(0))
                 ORDER BY zz.desde DESC) z;
  END

  ELSE IF @v = N'fact_respuesta'
  BEGIN
    DELETE FROM bi.fact_respuesta;
    CREATE TABLE #planas (envio_id uniqueidentifier, version_id uniqueidentifier, ruta nvarchar(450),
                          variable nvarchar(450), dato nvarchar(max), tipo int);
    ;WITH niveles AS (
      SELECT i.id AS envio_id, i.questionnaire_version_id AS version_id,
             CAST(N'' AS nvarchar(450)) AS ruta, CAST(i.answers AS nvarchar(max)) AS obj
      FROM dbo.interviews i
      UNION ALL
      SELECT n.envio_id, n.version_id,
             CAST(CASE WHEN n.ruta = N'' THEN CAST(CAST(m.[key] AS int) + 1 AS nvarchar(20))
                       ELSE n.ruta + N'.' + CAST(CAST(m.[key] AS int) + 1 AS nvarchar(20)) END AS nvarchar(450)),
             CAST(m.[value] AS nvarchar(max))
      FROM niveles n
      CROSS APPLY OPENJSON(n.obj) a
      CROSS APPLY OPENJSON(CASE WHEN a.[type] = 4 THEN a.[value] ELSE N'[]' END) m
      WHERE a.[type] = 4 AND m.[type] = 5
    )
    INSERT INTO #planas
    SELECT n.envio_id, n.version_id, n.ruta, a.[key], a.[value], a.[type]
    FROM niveles n CROSS APPLY OPENJSON(n.obj) a
    -- Roster lists are walked above, not answers.
    WHERE NOT (a.[type] = 4 AND EXISTS (
      SELECT 1 FROM OPENJSON(CASE WHEN a.[type] = 4 THEN a.[value] ELSE N'[]' END) e WHERE e.[type] = 5))
    OPTION (MAXRECURSION 0);

    INSERT INTO #planas
    SELECT r.id, r.point_id, N'', N'_CARA', CAST(r.score AS nvarchar(20)), 2 FROM dbo.feedback_responses r;
    INSERT INTO #planas
    SELECT r.id, r.point_id, N'', N'_COMENTARIO', r.comment, 1
    FROM dbo.feedback_responses r WHERE r.comment IS NOT NULL;
    INSERT INTO #planas
    SELECT r.id, r.point_id, N'', a.[key], a.[value], a.[type]
    FROM dbo.feedback_responses r CROSS APPLY OPENJSON(ISNULL(r.answers, N'{}')) a;

    SELECT v.id AS version_id, s.[key] COLLATE DATABASE_DEFAULT AS clase, JSON_VALUE(s.[value] COLLATE DATABASE_DEFAULT, '$.code') AS codigo
    INTO #esp
    FROM dbo.questionnaire_versions v
    CROSS APPLY OPENJSON(v.compiled, '$.questionnaire.settings.specialCodes') s;

    -- Atoms: a value, a ticked or ranked option, an empty list, a grid row.
    CREATE TABLE #atomos (envio_id uniqueidentifier, version_id uniqueidentifier, ruta nvarchar(450),
      variable nvarchar(450), fila nvarchar(450), posicion int, v nvarchar(max), vtipo int);
    INSERT INTO #atomos
    SELECT envio_id, version_id, ruta, variable, NULL, NULL, dato, tipo FROM #planas
    WHERE tipo IN (1, 2, 3) OR (tipo = 5 AND CASE WHEN tipo = 5 THEN JSON_VALUE(dato, '$."$special"') END IS NOT NULL);
    INSERT INTO #atomos
    SELECT p.envio_id, p.version_id, p.ruta, p.variable, NULL, CAST(e.[key] AS int) + 1, e.[value], e.[type]
    FROM #planas p CROSS APPLY OPENJSON(CASE WHEN p.tipo = 4 THEN p.dato ELSE N'[]' END) e WHERE p.tipo = 4;
    INSERT INTO #atomos
    SELECT envio_id, version_id, ruta, variable, NULL, NULL, NULL, 0 FROM #planas
    WHERE tipo = 4 AND NOT EXISTS (SELECT 1 FROM OPENJSON(CASE WHEN tipo = 4 THEN dato ELSE N'[]' END));
    INSERT INTO #atomos
    SELECT p.envio_id, p.version_id, p.ruta, p.variable, g.[key], NULL, g.[value], g.[type]
    FROM #planas p CROSS APPLY OPENJSON(CASE WHEN p.tipo = 5 THEN p.dato ELSE N'{}' END) g
    WHERE p.tipo = 5 AND CASE WHEN p.tipo = 5 THEN JSON_VALUE(p.dato, '$."$special"') END IS NULL;

    ;WITH conesp AS (
      SELECT a.*, CASE WHEN a.vtipo = 5 THEN JSON_VALUE(a.v, '$."$special"') END AS sp FROM #atomos a
    ), valores AS (
      SELECT a.envio_id, a.version_id, a.ruta, a.variable, a.fila, a.posicion,
             CASE WHEN a.sp IS NOT NULL THEN s.codigo ELSE a.v END AS valor,
             CAST(CASE WHEN a.sp IS NOT NULL THEN 1 ELSE 0 END AS bit) AS especial,
             a.sp AS especial_clase
      FROM conesp a
      LEFT JOIN #esp s ON s.version_id = a.version_id AND a.sp IS NOT NULL
        AND s.clase COLLATE Latin1_General_100_BIN2 = a.sp COLLATE Latin1_General_100_BIN2
    ), k AS (
      SELECT v.*,
             bi.clave(CONCAT(LOWER(CONVERT(varchar(36), v.envio_id)), N'|', v.variable, N'|', v.ruta, N'|',
               ISNULL(v.fila, N''), N'|', ISNULL(CAST(v.posicion AS nvarchar(20)), N''), N'|', ISNULL(v.valor, N''))) AS respuesta_id,
             bi.clave(CONCAT(LOWER(CONVERT(varchar(36), v.version_id)), N'|', v.variable)) AS pregunta_id,
             bi.clave(CONCAT(LOWER(CONVERT(varchar(36), v.version_id)), N'|', v.variable, N'|', ISNULL(v.valor, N''))) AS opcion_clave
      FROM valores v
    ), dedup AS (
      SELECT k.*, ROW_NUMBER() OVER (PARTITION BY respuesta_id ORDER BY (SELECT NULL)) AS rn FROM k
    )
    INSERT INTO bi.fact_respuesta (respuesta_id, envio_id, pregunta_id, version_id, variable, opcion_id,
      fila_id, ruta, miembro, fila_codigo, posicion, valor, especial, especial_clase, valor_numero)
    SELECT d.respuesta_id, d.envio_id, d.pregunta_id, d.version_id, d.variable, o.opcion_id,
           CASE WHEN d.fila IS NOT NULL THEN
             bi.clave(CONCAT(LOWER(CONVERT(varchar(36), d.version_id)), N'|', d.variable, N'|', d.fila)) END,
           NULLIF(d.ruta, N''),
           CASE WHEN d.ruta = N'' THEN NULL
                WHEN CHARINDEX(N'.', d.ruta) = 0 THEN CAST(d.ruta AS int)
                ELSE CAST(LEFT(d.ruta, CHARINDEX(N'.', d.ruta) - 1) AS int) END,
           d.fila, d.posicion, d.valor,
           CAST(CASE WHEN d.especial = 1 OR ISNULL(o.especial, 0) = 1 THEN 1 ELSE 0 END AS bit),
           d.especial_clase,
           CASE WHEN d.especial = 0 AND ISNULL(o.especial, 0) = 0 AND d.valor LIKE N'[0-9-]%'
                     AND d.valor NOT LIKE N'%[^0-9.-]%' AND LEN(d.valor) <= 38
                THEN TRY_CAST(d.valor AS decimal(38, 10)) END
    FROM dedup d
    LEFT JOIN bi.dim_opcion o ON o.opcion_id = d.opcion_clave
    WHERE d.rn = 1;
    DROP TABLE #planas; DROP TABLE #atomos; DROP TABLE #esp;
  END

  ELSE IF @v = N'fact_paradato'
  BEGIN
    DELETE FROM bi.fact_paradato;
    INSERT INTO bi.fact_paradato (paradato_id, envio_id, version_id, tipo, en, fecha, dispositivo,
      secuencia, ms_monotono, clave_posicion, pregunta_id, variable, ruta, destino, segundos,
      latitud, longitud, precision_m, momento, nota, payload)
    SELECT e.id, e.interview_id, i.questionnaire_version_id, e.type, e.at,
           CAST(DATEADD(minute, ISNULL(z.minutos, 0),
             CAST(SWITCHOFFSET(e.at, '+00:00') AS datetime2(3))) AS date),
           e.device_id, e.seq, e.monotonic_ms, c.clave,
           CASE WHEN c.clave IS NOT NULL THEN
             bi.clave(CONCAT(LOWER(CONVERT(varchar(36), i.questionnaire_version_id)), N'|', bi.variable_de(c.clave))) END,
           bi.variable_de(c.clave), bi.ruta_de(c.clave),
           JSON_VALUE(e.payload, '$.to'),
           ROUND(TRY_CAST(COALESCE(JSON_VALUE(e.payload, '$.ms'), JSON_VALUE(e.payload, '$.hiddenMs')) AS decimal(38, 10)) / 1000.0, 1),
           TRY_CAST(JSON_VALUE(e.payload, '$.lat') AS decimal(18, 8)),
           TRY_CAST(JSON_VALUE(e.payload, '$.lng') AS decimal(18, 8)),
           TRY_CAST(JSON_VALUE(e.payload, '$.accuracy') AS decimal(18, 2)),
           JSON_VALUE(e.payload, '$.when'), JSON_VALUE(e.payload, '$.text'), e.payload
    FROM dbo.interview_paradata e
    JOIN dbo.interviews i ON i.id = e.interview_id
    JOIN dbo.projects p ON p.id = i.project_id
    CROSS APPLY (SELECT CAST(COALESCE(JSON_VALUE(e.payload, '$.key'), JSON_VALUE(e.payload, '$.from')) AS nvarchar(450)) AS clave) c
    OUTER APPLY (SELECT TOP 1 zz.minutos FROM bi.zona zz
                 WHERE zz.tz = p.timezone
                   AND zz.desde <= CAST(SWITCHOFFSET(e.at, '+00:00') AS datetime2(0))
                 ORDER BY zz.desde DESC) z;
  END

  ELSE
  BEGIN
    -- The flat table: a join of everything, rebuilt.
    IF OBJECT_ID(N'bi.plano_respuestas', N'U') IS NOT NULL DROP TABLE bi.plano_respuestas;
    SELECT org.organizacion, pr.proyecto_codigo, pr.proyecto,
           ins.instrumento_tipo, ins.instrumento, ve.version_numero,
           e.envio_id, ca.caso_codigo, pe.persona AS entrevistador, pe.equipos,
           e.canal, cn.canal_nombre, e.estado, e.resultado, e.completa,
           e.fecha, fe.anio, fe.mes, fe.anio_mes, fe.semana_iso, fe.dia_nombre,
           e.enviado_en, e.segundos_activos, e.cara, e.referencia,
           e.retrocesos, e.notas, e.pausas, e.advertencias, e.alertas, e.motivo_salida,
           r.variable, pg.pregunta, pg.tipo AS pregunta_tipo, pg.lista, pg.personal,
           r.ruta, r.miembro, fi.fila, r.posicion,
           r.valor AS codigo, COALESCE(op.etiqueta, r.valor) AS respuesta,
           r.especial AS respuesta_especial, r.valor_numero,
           pg.orden AS pregunta_orden, op.orden AS opcion_orden
    INTO bi.plano_respuestas
    FROM bi.fact_respuesta r
    JOIN bi.fact_envio e ON e.envio_id = r.envio_id
    LEFT JOIN bi.dim_pregunta pg ON pg.pregunta_id = r.pregunta_id
    JOIN bi.dim_version ve ON ve.version_id = r.version_id
    JOIN bi.dim_instrumento ins ON ins.instrumento_id = ve.instrumento_id
    JOIN bi.dim_proyecto pr ON pr.proyecto_id = ins.proyecto_id
    JOIN bi.dim_organizacion org ON org.organizacion_id = pr.organizacion_id
    LEFT JOIN bi.dim_opcion op ON op.opcion_id = r.opcion_id
    LEFT JOIN bi.dim_fila fi ON fi.fila_id = r.fila_id
    LEFT JOIN bi.dim_caso ca ON ca.caso_id = e.caso_id
    LEFT JOIN bi.dim_persona pe ON pe.persona_id = e.persona_id AND pe.organizacion_id = pr.organizacion_id
    LEFT JOIN bi.dim_canal cn ON cn.canal = e.canal
    LEFT JOIN bi.dim_fecha fe ON fe.fecha = e.fecha;
    CREATE INDEX plano_respuestas_fecha_idx ON bi.plano_respuestas (fecha);
    CREATE INDEX plano_respuestas_envio_idx ON bi.plano_respuestas (envio_id);
  END
END;
