# Analysis model (schema `bi`)

Migration `0009_bi` (with `0016` and `0022`) adds a schema `bi` in the SQL Server database that turns the coded answers and the paradata into tables that plain SQL, or any tool that reads SQL Server (Power BI, Excel, Tableau, Looker Studio…), can read. No tool-specific output is made: the model is read with a SQL query. It covers every organisation, project, questionnaire (CATI, CAPI, CAWI, PAPI) and feedback point. Table and column names are in Spanish, for the analysts who read them.

## Two shapes

**Snowflake.** Three facts and their dimensions, joined on single text keys:

```
dim_organizacion ← dim_proyecto ← dim_instrumento ← dim_version ← dim_pregunta ← dim_opcion
                                                                              ← dim_fila
fact_envio      → dim_caso, dim_persona, dim_canal, dim_fecha, dim_version
fact_respuesta  → fact_envio, dim_pregunta, dim_opcion, dim_fila
fact_paradato   → fact_envio, dim_pregunta, dim_evento   (and fact_respuesta on envio_id + variable + ruta)
```

| Table             | Grain                                                                                                                                                                                 | Notes                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fact_envio`      | An interview (any mode, any keying) or a feedback response                                                                                                                            | Channel, date (project time zone), status, result, `completa` (0/1), active seconds, face (feedback), paradata counts (`retrocesos`, `notas`, `pausas`, `advertencias`) and review flags (`alertas`)                             |
| `fact_respuesta`  | One atomic answer: a value, a ticked or ranked option (`posicion`), a grid row (`fila_codigo`), at any roster depth (`ruta`: `2` is the second member, `2.1` the first row inside it) | `valor` as given (a special answer as its code, `especial` true); `valor_numero` for sums and means, empty for special answers, so averages count real answers only. An answer given as an empty list is one row with no `valor` |
| `fact_paradato`   | One paradata event                                                                                                                                                                    | Type (`dim_evento`), time, device; the question it is about (`pregunta_id`, `variable`, `ruta`), seconds on it or away, back moves' destination, GPS position, note text and the raw `payload`                                   |
| `dim_instrumento` | A questionnaire or a feedback point                                                                                                                                                   | `instrumento_tipo`: `cuestionario` or `valoracion`                                                                                                                                                                               |
| `dim_version`     | A published version                                                                                                                                                                   | Every answer joins the version it was given on, so labels never mix across versions. A feedback point has one definition in force                                                                                                |
| `dim_pregunta`    | A variable of a version                                                                                                                                                               | Questions in groups and rosters (`lista`, `cadena`), computed variables, personal questions flagged (`personal`), and for feedback points `_CARA` (the face) and `_COMENTARIO`                                                   |
| `dim_opcion`      | A code of a question                                                                                                                                                                  | Own options, shared answer sets, yes/no, Likert and NPS points, special codes (`especial`) and faces                                                                                                                             |
| `dim_fila`        | A grid row                                                                                                                                                                            |                                                                                                                                                                                                                                  |
| `dim_caso`        | A case                                                                                                                                                                                | Code, role in the sample, stratum, probability and base weight. No personal data: that stays sealed                                                                                                                              |
| `dim_persona`     | A person                                                                                                                                                                              | Name and teams                                                                                                                                                                                                                   |
| `dim_canal`       | CATI, CAPI, CAWI, PAPI, and the feedback channels                                                                                                                                     |                                                                                                                                                                                                                                  |
| `dim_evento`      | A kind of paradata event                                                                                                                                                              | Name and group (navigation, session, quality, location, paper)                                                                                                                                                                   |
| `dim_fecha`       | A day                                                                                                                                                                                 | Year, quarter, month, ISO week, weekday, business day                                                                                                                                                                            |

Texts and labels are plain, as the exports write them: tags dropped and piped values (`{{…}}`, which differ per respondent) shown as `…`, in the questionnaire's default language. Every language is kept in the `*_i18n` columns. Answers to a feedback question since removed from its point keep their variable but have no text.

**Flat.** `bi.plano_respuestas` has one row per atomic answer with everything on it: organisation, project, instrument and version, case, interviewer and teams, channel, dates, status, paradata counts and flags, variable, question, roster path and member, grid row, position, code, **answer label** and numeric value.

### Crossing answers and paradata

`fact_paradato` joins the answers on the submission, the variable and the roster row:

```sql
-- Seconds spent on each question, beside its answer.
select r.variable, r.ruta, o.etiqueta, sum(d.segundos) as segundos
from bi.fact_paradato d
join bi.fact_respuesta r
  on r.envio_id = d.envio_id and r.variable = d.variable
 and (r.ruta = d.ruta or (r.ruta is null and d.ruta is null))
left join bi.dim_opcion o on o.opcion_id = r.opcion_id
where d.tipo = 'leave_question'
group by r.variable, r.ruta, o.etiqueta;
```

## The SQL export

Exports offer a **SQL query** format: a `.sql` file with one query per sheet of the Excel export (the data, and a sheet per roster with "a table per roster"). Run on this schema, it gives the same columns, in the same order, with the same cells, for the options and filters chosen: codes or labels, rosters wide or long, paradata, mode, interviewer, dates, approved only. Its columns are the export's own (`Column.source` in `@wansurvey/exporters`, read by `apps/api/src/exports/sql-export.ts`), and a test compares both, cell by cell, over every question type. The codebook sheets are not part of it. Since the tables hold the data of their last refresh, interviews submitted after it appear in the Excel but not yet in the query.

## Refresh

SQL Server has no materialised views, so every table of the model is a **table**: the dimensions of the hierarchy (`dim_organizacion`, `dim_proyecto`, `dim_instrumento`, `dim_version`, `dim_caso`, `dim_persona`, `dim_fecha`) and the question, option and row dimensions, the facts and the flat table. Procedures that belong to the database owner empty and fill them; the application runs those and nothing else. A table shows the data as of the last refresh. (`dim_canal` and `dim_evento` are fixed lists and stay views. The `fuente_*` views are the sources of the dimensions: they are read by the refresh and by nobody else.)

The worker refreshes the model on `BI_REFRESH_CRON` (UTC cron, default `40 */6 * * *`, every 6 hours; `off` never), on the heavy queue, and only when something the model reads changed (`bi.estado_actual` gives a fingerprint of the source tables, `bi.marcar_huella` keeps the one of the last refresh). The dimensions of the hierarchy are refilled first, in one transaction, then each other table in its own, one refresh at a time (an application lock). The tables are emptied and refilled, except the flat table, which is rebuilt: on Azure SQL Database, which reads with row versioning, a reader keeps seeing the previous data of a refilled table until its refresh commits, and waits only for the moment the flat table is swapped; on a SQL Server without row versioning, a reader of a table being refreshed waits for it.

The frequency can also be set in the application (Administration → Organization → Analysis model refresh): every 15 minutes up to once a week, or never. It is one setting for the installation, kept in `dbo.app_settings` (migration `0025`). Once it is set, a job that wakes every ten minutes (`bi.tick`) refreshes the model when the interval has passed since the last check, and the `BI_REFRESH_CRON` schedule stands aside; removing the setting (\"as the deployment sets it\") brings the cron back. A refresh can also be asked for at once there.

To refresh by hand, with a login that can run the procedures (the database owner):

```sql
exec bi.refrescar;
```

The tables are created empty, except the dimensions of the hierarchy, which migration `0022` fills: the first scheduled run (or the command above) fills the rest.

## Access

The model **spans every organisation** and has no row-level security: the tables are filled by the owner, whose reads the policy lets through. The application user (`wansurvey_app`) may only run the refresh procedures and cannot read anything in `bi`. An analysis user is made apart, in the application's database, with read access to the schema only:

```sql
-- SQL Server: a login at the server, and a user in the database.
create login wansurvey_bi with password = '…';
create user wansurvey_bi for login wansurvey_bi;
grant select on schema::bi to wansurvey_bi;

-- Azure SQL Database: a user of the database, with a password or a Microsoft Entra account.
create user wansurvey_bi with password = '…';
-- create user [analyst@institution.org] from external provider;
grant select on schema::bi to wansurvey_bi;
```

Do not grant anything on `dbo`: the model needs none, and the application's tables are under row-level security. For one organisation's own analysts, put views filtered on `organizacion_id` in front of these tables and grant only those. Personal questions (`dim_pregunta.personal`) are in the model; filter them out for users who may not see personal data, as the exports do.

## Examples

```sql
-- Share of each answer to A3_SEX per project, complete interviews only.
select proyecto, respuesta, count(*) * 100.0 / sum(count(*)) over (partition by proyecto) as pct
from bi.plano_respuestas
where variable = 'A3_SEX' and completa = 1
group by proyecto, respuesta;

-- Mean age, without the special codes; and how many did not know.
select avg(valor_numero), sum(case when respuesta_especial = 1 then 1 else 0 end)
from bi.plano_respuestas where variable = 'A2_AGE';

-- Faces by month and channel.
select anio_mes, canal_nombre, respuesta, count(*)
from bi.plano_respuestas where variable = '_CARA'
group by anio_mes, canal_nombre, respuesta order by anio_mes;
```
