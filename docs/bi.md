# Analysis model (schema `bi`)

Migration `0034_bi_model` adds a schema `bi` that turns the coded answers into tables a BI tool (Power BI, Tableau, Looker Studio…) or plain SQL can read. It covers every organisation, project, questionnaire (CATI, CAPI, CAWI, PAPI) and feedback point. Table and column names are in Spanish, for the analysts who read them.

## Two shapes

**Snowflake.** Two facts and their dimensions, joined on single text keys:

```
dim_organizacion ← dim_proyecto ← dim_instrumento ← dim_version ← dim_pregunta ← dim_opcion
                                                                              ← dim_fila
fact_envio      → dim_caso, dim_persona, dim_canal, dim_fecha, dim_version
fact_respuesta  → fact_envio, dim_pregunta, dim_opcion, dim_fila
```

| Table             | Grain                                                                    | Notes                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fact_envio`      | An interview (any mode) or a feedback response                           | Channel, date (project time zone), status, result, `completa` (0/1), active seconds, face (feedback)                                                      |
| `fact_respuesta`  | One atomic answer: a ticked option, a grid row, a roster member's answer | `valor` as given; `valor_numero` for sums and means, empty for don't know (-8), refused (-9) and not applicable (-7), so averages count real answers only |
| `dim_instrumento` | A questionnaire or a feedback point                                      | `instrumento_tipo`: `cuestionario` or `valoracion`                                                                                                        |
| `dim_version`     | A published version                                                      | Every answer joins the version it was given on, so labels never mix across versions. A feedback point has one definition in force                         |
| `dim_pregunta`    | A variable of a version                                                  | Questions in groups and rosters, computed variables, and for feedback points `_CARA` (the face) and `_COMENTARIO`                                         |
| `dim_opcion`      | A code of a question                                                     | Own options, shared answer sets, yes/no, special codes (`especial`) and faces                                                                             |
| `dim_fila`        | A grid row                                                               |                                                                                                                                                           |
| `dim_caso`        | A case                                                                   | No personal data: that stays sealed                                                                                                                       |
| `dim_persona`     | A person                                                                 | Name and teams                                                                                                                                            |
| `dim_canal`       | CATI, CAPI, CAWI, PAPI, and the feedback channels                        |                                                                                                                                                           |
| `dim_fecha`       | A day                                                                    | Year, quarter, month, ISO week, weekday, business day                                                                                                     |

**Flat.** `bi.plano_respuestas` has one row per atomic answer with everything on it: organisation, project, instrument and version, case, interviewer and teams, channel, dates, status, variable, question, roster member, grid row, code, **answer label** and numeric value.

Question texts are as designed: `{{…}}` placeholders are filled during the interview, not here. Answers to a feedback question since removed from its point keep their variable but have no text.

## Refresh

The question, option and row dimensions, both facts and the flat table are materialised views with indexes, so reading them is fast; they show the data as of the last refresh. The worker refreshes them on `BI_REFRESH_CRON` (UTC, default `20 * * * *`, hourly; `off` never) through `bi.refrescar()`. Once filled, a refresh does not block readers (except the flat table, for the moment it is swapped). They are created empty: the first scheduled run fills them, or run it by hand:

```sql
select bi.refrescar();
```

## Access

The views read with their owner's rights, so they **span every organisation**. The application role `wansurvey_app` may only run `bi.refrescar()` (a security definer function); it cannot read anything in `bi`. Give the schema to an internal analysis role only:

```sql
create role wansurvey_bi login password '…';
grant usage on schema bi to wansurvey_bi;
grant select on all tables in schema bi to wansurvey_bi;
grant execute on all functions in schema bi to wansurvey_bi;
```

For one organisation's own analysts, put views filtered on `organizacion_id` in front of these and grant only those.

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
