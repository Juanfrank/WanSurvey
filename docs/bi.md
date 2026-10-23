# Analysis model (schema `bi`)

Migrations `0034_bi_model` and `0035_bi_model_v2` add a schema `bi` that turns the coded answers and the paradata into tables a BI tool (Power BI, Tableau, Looker Studio…) or plain SQL can read. It covers every organisation, project, questionnaire (CATI, CAPI, CAWI, PAPI) and feedback point. Table and column names are in Spanish, for the analysts who read them.

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
 and r.ruta is not distinct from d.ruta
left join bi.dim_opcion o on o.opcion_id = r.opcion_id
where d.tipo = 'leave_question'
group by 1, 2, 3;
```

## The SQL export

Exports offer a **SQL query** format: a `.sql` file with one query per sheet of the Excel export (the data, and a sheet per roster with "a table per roster"). Run on this schema, it gives the same columns, in the same order, with the same cells, for the options and filters chosen: codes or labels, rosters wide or long, paradata, mode, interviewer, dates, approved only. Its columns are the export's own (`Column.source` in `@wansurvey/exporters`, read by `apps/api/src/exports/sql-export.ts`), and a test compares both, cell by cell, over every question type. The codebook sheets are not part of it. Since the views hold the data of their last refresh, interviews submitted after it appear in the Excel but not yet in the query.

## Refresh

The question, option and row dimensions, the facts and the flat table are materialised views with indexes, so reading them is fast; they show the data as of the last refresh. The worker refreshes them on `BI_REFRESH_CRON` (UTC, default `40 */6 * * *`, every 6 hours; `off` never), on the heavy queue, and only when something they read changed (`bi.huella()`, a fingerprint of the source tables). Each view is refreshed in its own transaction with a 15-minute limit (`bi.refrescar_vista`), so readers wait for one view at most. Once filled, a refresh does not block readers (except the flat table, for the moment it is swapped). They are created empty: the first scheduled run fills them, or run it by hand:

```sql
select bi.refrescar();
```

## Access

The views read with their owner's rights, so they **span every organisation**. The application role `wansurvey_app` may only run `bi.refrescar()` (a security definer function); it cannot read anything in `bi`. Give the schema to an internal analysis role only (again after migration 0035, which rebuilds the schema):

```sql
create role wansurvey_bi login password '…';
grant usage on schema bi to wansurvey_bi;
grant select on all tables in schema bi to wansurvey_bi;
grant execute on all functions in schema bi to wansurvey_bi;
```

For one organisation's own analysts, put views filtered on `organizacion_id` in front of these and grant only those. Personal questions (`dim_pregunta.personal`) are in the model; filter them out for roles that may not see personal data, as the exports do.

## Examples

```sql
-- Share of each answer to A3_SEX per project, complete interviews only.
select proyecto, respuesta, count(*) * 100.0 / sum(count(*)) over (partition by proyecto) as pct
from bi.plano_respuestas
where variable = 'A3_SEX' and completa = 1
group by proyecto, respuesta;

-- Mean age, without the special codes; and how many did not know.
select avg(valor_numero), count(*) filter (where respuesta_especial)
from bi.plano_respuestas where variable = 'A2_AGE';

-- Faces by month and channel.
select anio_mes, canal_nombre, respuesta, count(*)
from bi.plano_respuestas where variable = '_CARA'
group by 1, 2, 3 order by 1;
```
