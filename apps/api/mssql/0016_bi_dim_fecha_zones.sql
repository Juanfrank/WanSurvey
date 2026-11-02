-- bi.dim_fecha started at the UTC date of the first interview, but an interview's day in the
-- facts is the local day of its project's zone: an interview made in the evening west of UTC
-- (the Dominican Republic, UTC-4) belongs to the day before its UTC date, which the dimension did
-- not have, and its year, month and week came out empty in bi.plano_respuestas. The dimension now
-- starts one day earlier, more than any zone's offset.
CREATE OR ALTER VIEW bi.dim_fecha AS
SELECT d.fecha, YEAR(d.fecha) AS anio, DATEPART(quarter, d.fecha) AS trimestre,
       MONTH(d.fecha) AS mes, CONVERT(char(7), d.fecha, 126) AS anio_mes,
       YEAR(DATEADD(day, 26 - DATEPART(iso_week, d.fecha), d.fecha)) AS anio_iso,
       DATEPART(iso_week, d.fecha) AS semana_iso, DAY(d.fecha) AS dia,
       w.dow AS dia_semana,
       CHOOSE(w.dow, N'lunes', N'martes', N'miércoles', N'jueves', N'viernes', N'sábado', N'domingo') AS dia_nombre,
       CAST(CASE WHEN w.dow < 6 THEN 1 ELSE 0 END AS bit) AS habil
FROM (
  SELECT TOP ((SELECT DATEDIFF(day,
                 DATEADD(day, -1, ISNULL((SELECT CAST(MIN(started_at) AS date) FROM dbo.interviews), CAST(SYSDATETIME() AS date))),
                 DATEADD(year, 1, CAST(SYSDATETIME() AS date))) + 1))
         DATEADD(day, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1,
           DATEADD(day, -1, ISNULL((SELECT CAST(MIN(started_at) AS date) FROM dbo.interviews), CAST(SYSDATETIME() AS date)))) AS fecha
  FROM sys.all_objects a CROSS JOIN sys.all_objects b
) d
CROSS APPLY (SELECT ((DATEDIFF(day, '19000101', d.fecha) % 7) + 7) % 7 + 1 AS dow) w;
