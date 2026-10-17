-- Analysis model (schema bi): every organisation's projects, questionnaires (CATI, CAPI, CAWI,
-- PAPI) and feedback points, as a snowflake (fact_envio, fact_respuesta and their dimensions)
-- and as one flat table (plano_respuestas). Names are in Spanish: it is read by analysts in
-- BI tools. Personal data of cases is not exposed (it stays sealed in cases.sample_pii).
--
-- The views read with their owner's rights, so they span every organisation: they are for an
-- internal analysis role (see docs/bi.md), never for wansurvey_app. The app only runs
-- bi.refrescar() (security definer) from the worker's schedule. The materialised views are
-- created empty; the first refresh fills them.
create schema if not exists bi;
--> statement-breakpoint
-- A localised text in the language asked for, or the first one there is.
create or replace function bi.texto(t jsonb, lang text) returns text
language sql immutable as $$
  select coalesce(t->>lang, (select value from jsonb_each_text(t) limit 1))
$$;
--> statement-breakpoint
create or replace function bi.clave(variadic partes text[]) returns text
language sql immutable as $$ select md5(array_to_string(partes, '|')) $$;
--> statement-breakpoint
-- ─── Hierarchy dimensions ─────────────────────────────────────────────────────────────

create or replace view bi.dim_organizacion as
select id as organizacion_id, name as organizacion, slug
from tenants;
--> statement-breakpoint
create or replace view bi.dim_proyecto as
select id as proyecto_id, tenant_id as organizacion_id, code as proyecto_codigo,
       name as proyecto, status as proyecto_estado, timezone as zona_horaria,
       created_at as creado_en
from projects;
--> statement-breakpoint
-- Questionnaires and feedback points, as one kind of "instrument".
create or replace view bi.dim_instrumento as
select id as instrumento_id, project_id as proyecto_id, 'cuestionario' as instrumento_tipo,
       name as instrumento, state as instrumento_estado
from questionnaires
union all
select id, project_id, 'valoracion', name, case when active then 'active' else 'disabled' end
from feedback_points;
--> statement-breakpoint
create or replace view bi.dim_version as
select v.id as version_id, v.questionnaire_id as instrumento_id, v.version as version_numero,
       v.published_at as publicada_en, v.retired_at as retirada_en,
       v.compiled->'questionnaire'->>'defaultLanguage' as idioma
from questionnaire_versions v
union all
-- A feedback point has one definition in force: its version is the point itself.
select p.id, p.id, p.version, p.created_at, null, 'es'
from feedback_points p;
--> statement-breakpoint
-- Questions (also those in groups and rosters) and computed variables. A feedback point's
-- face and comment are _CARA and _COMENTARIO (item ids start with a letter).
create materialized view bi.dim_pregunta as
with cuestionario as (
  select v.id as version_id, q->>'name' as variable, q->>'type' as tipo,
         bi.texto(q->'text', v.compiled->'questionnaire'->>'defaultLanguage') as pregunta,
         v.compiled->'vars'->(q->>'name')->'rosterChain'->>-1 as lista, n as orden
  from questionnaire_versions v,
       jsonb_path_query(v.compiled->'questionnaire'->'sections', 'strict $.**')
         with ordinality x(q, n)
  where jsonb_typeof(q) = 'object' and q->>'kind' = 'question'
  union all
  select v.id, x.key, x.value->>'kind', null, x.value->'rosterChain'->>-1, 100000
  from questionnaire_versions v, jsonb_each(v.compiled->'vars') x
  where x.value->>'kind' in ('computed', 'other')
),
valoracion as (
  select id as version_id, '_CARA' as variable, 'faces' as tipo,
         bi.texto(question, 'es') as pregunta, null as lista, 0::bigint as orden
  from feedback_points
  union all
  select id, '_COMENTARIO', 'text', 'Comentario', null, 1000 from feedback_points
  union all
  select p.id, it->>'id', it->>'type', bi.texto(it->'text', 'es'), null, 1 + n
  from feedback_points p, jsonb_array_elements(p.items) with ordinality x(it, n)
)
select bi.clave(version_id::text, variable) as pregunta_id, version_id, variable, tipo,
       pregunta, lista, orden
from cuestionario
union all
select bi.clave(version_id::text, variable), version_id, variable, tipo, pregunta, lista, orden
from valoracion
with no data;
--> statement-breakpoint
-- Codes and labels: own options, shared answer sets, yes/no, special codes (don't know,
-- refused…) and the faces of feedback points.
create materialized view bi.dim_opcion as
with opciones as (
  select v.id as version_id, q->>'name' as variable, o->>'code' as codigo,
         bi.texto(o->'label', v.compiled->'questionnaire'->>'defaultLanguage') as etiqueta,
         false as especial, k as orden
  from questionnaire_versions v,
       jsonb_path_query(v.compiled->'questionnaire'->'sections', 'strict $.**') q,
       jsonb_array_elements(coalesce(q->'options',
         v.compiled->'questionnaire'->'answerSets'->(q->>'answerSetId'))) with ordinality m(o, k)
  where jsonb_typeof(q) = 'object' and q->>'kind' = 'question'
    and (q ? 'options' or q ? 'answerSetId')
  union all
  select p.version_id, p.variable, s.codigo, s.etiqueta, false, s.orden
  from bi.dim_pregunta p,
       (values ('1', 'Sí', 1), ('2', 'No', 2)) s(codigo, etiqueta, orden)
  where p.tipo = 'yesno'
  union all
  select v.id, p.variable, s.value->>'code',
         bi.texto(s.value->'label', v.compiled->'questionnaire'->>'defaultLanguage'), true, 1000
  from bi.dim_pregunta p
  join questionnaire_versions v on v.id = p.version_id,
       jsonb_each(v.compiled->'questionnaire'->'settings'->'specialCodes') s
  where p.tipo in ('single', 'multi', 'yesno', 'numeric', 'grid', 'scale', 'ranking')
  union all
  select f.id, '_CARA', c::text,
         (case when f.faces = 5 then array['Muy mal', 'Mal', 'Regular', 'Bien', 'Muy bien']
               else array['Mal', 'Regular', 'Bien'] end)[c], false, c
  from feedback_points f, generate_series(1, f.faces) c
  union all
  select f.id, it->>'id', o->>'code', bi.texto(o->'label', 'es'), false, k
  from feedback_points f, jsonb_array_elements(f.items) it,
       jsonb_array_elements(it->'options') with ordinality m(o, k)
  where it ? 'options'
  union all
  select f.id, it->>'id', s.codigo, s.etiqueta, false, s.orden
  from feedback_points f, jsonb_array_elements(f.items) it,
       (values ('1', 'Sí', 1), ('2', 'No', 2)) s(codigo, etiqueta, orden)
  where it->>'type' = 'yesno'
)
select distinct on (version_id, variable, codigo)
       bi.clave(version_id::text, variable, codigo) as opcion_id,
       bi.clave(version_id::text, variable) as pregunta_id,
       codigo, etiqueta, especial, orden
from opciones
order by version_id, variable, codigo, especial
with no data;
--> statement-breakpoint
-- Grid rows (D6_GRID → a, b, c).
create materialized view bi.dim_fila as
select bi.clave(v.id::text, q->>'name', r->>'code') as fila_id,
       bi.clave(v.id::text, q->>'name') as pregunta_id,
       r->>'code' as fila_codigo,
       bi.texto(r->'label', v.compiled->'questionnaire'->>'defaultLanguage') as fila,
       n as orden
from questionnaire_versions v,
     jsonb_path_query(v.compiled->'questionnaire'->'sections', 'strict $.**') q,
     jsonb_array_elements(q->'rows') with ordinality g(r, n)
where jsonb_typeof(q) = 'object' and q->>'kind' = 'question' and q ? 'rows'
with no data;
--> statement-breakpoint
-- ─── Other dimensions ─────────────────────────────────────────────────────────────────

-- Cases without personal data (that stays sealed).
create or replace view bi.dim_caso as
select id as caso_id, project_id as proyecto_id, questionnaire_id as instrumento_id,
       external_id as caso_codigo, status as caso_estado, disposition as caso_resultado,
       selection_role as rol_seleccion, inclusion_prob as prob_inclusion,
       base_weight as peso_base, sample as muestra
from cases;
--> statement-breakpoint
create or replace view bi.dim_persona as
select u.id as persona_id, u.name as persona,
       (select string_agg(t.name, ', ' order by t.name)
        from team_members m join teams t on t.id = m.team_id
        where m.user_id = u.id) as equipos
from users u;
--> statement-breakpoint
create or replace view bi.dim_canal as
select * from (values
  ('CATI', 'Teléfono', 'cuestionario'),
  ('CAPI', 'Presencial', 'cuestionario'),
  ('CAWI', 'Web', 'cuestionario'),
  ('PAPI', 'Papel', 'cuestionario'),
  ('link', 'Enlace', 'valoracion'),
  ('widget', 'Insertado en una web', 'valoracion'),
  ('paper', 'Folleto en papel', 'valoracion')
) c(canal, canal_nombre, instrumento_tipo);
--> statement-breakpoint
create or replace view bi.dim_fecha as
select d::date as fecha, extract(year from d)::int as anio,
       extract(quarter from d)::int as trimestre, extract(month from d)::int as mes,
       to_char(d, 'YYYY-MM') as anio_mes, extract(isoyear from d)::int as anio_iso,
       extract(week from d)::int as semana_iso, extract(day from d)::int as dia,
       extract(isodow from d)::int as dia_semana,
       (array['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'])
         [extract(isodow from d)::int] as dia_nombre,
       extract(isodow from d) < 6 as habil
from generate_series(
  coalesce((select least(min(started_at), (select min(created_at) from feedback_responses))
            from interviews), now())::date,
  (now() + interval '1 year')::date, interval '1 day') d;
--> statement-breakpoint
-- ─── Facts ────────────────────────────────────────────────────────────────────────────

-- A submission: an interview (any mode) or a feedback response.
create materialized view bi.fact_envio as
select i.id as envio_id, i.questionnaire_version_id as version_id, i.project_id as proyecto_id,
       i.case_id as caso_id, i.interviewer_id as persona_id, i.mode as canal,
       (coalesce(i.submitted_at, i.started_at) at time zone p.timezone)::date as fecha,
       i.started_at as iniciado_en, i.submitted_at as enviado_en,
       i.status as estado, i.disposition as resultado, i.language as idioma,
       i.entry_pass as digitacion, i.sampled as en_muestra_revision,
       round(i.active_ms / 1000.0) as segundos_activos,
       round(i.total_ms / 1000.0) as segundos_totales,
       null::int as cara, null::text as referencia,
       case when i.disposition = 'COMPLETE' then 1 else 0 end as completa
from interviews i join projects p on p.id = i.project_id
union all
select r.id, r.point_id, f.project_id, null, null, r.channel,
       (r.created_at at time zone p.timezone)::date, r.created_at, r.created_at,
       'submitted', 'COMPLETE', null, null, false, null, null,
       r.score, r.ref, 1
from feedback_responses r
join feedback_points f on f.id = r.point_id
join projects p on p.id = f.project_id
with no data;
--> statement-breakpoint
-- One atomic answer: a ticked option, a grid row, a roster member's answer. valor_numero
-- leaves special codes out, so sums and means count only real answers.
create materialized view bi.fact_respuesta as
with planas as (
  select i.id as envio_id, i.questionnaire_version_id as version_id,
         null::int as miembro, a.key as variable, a.value as dato
  from interviews i, jsonb_each(i.answers) a
  union all
  select i.id, i.questionnaire_version_id, m.n::int, r.key, r.value
  from interviews i, jsonb_each(i.answers) a,
       jsonb_array_elements(a.value) with ordinality m(fila, n),
       jsonb_each(m.fila) r
  where jsonb_typeof(a.value) = 'array' and jsonb_typeof(m.fila) = 'object'
  union all
  select r.id, r.point_id, null, '_CARA', to_jsonb(r.score) from feedback_responses r
  union all
  select r.id, r.point_id, null, '_COMENTARIO', to_jsonb(r.comment)
  from feedback_responses r where r.comment is not null
  union all
  select r.id, r.point_id, null, a.key, a.value
  from feedback_responses r, jsonb_each(coalesce(r.answers, '{}')) a
),
atomos as (
  select envio_id, version_id, miembro, variable, null::text as fila, dato #>> '{}' as valor
  from planas where jsonb_typeof(dato) in ('number', 'string', 'boolean')
  union all
  select envio_id, version_id, miembro, variable, null, e #>> '{}'
  from planas, jsonb_array_elements(dato) e
  where jsonb_typeof(dato) = 'array' and jsonb_typeof(e) <> 'object'
  union all
  select envio_id, version_id, miembro, variable, g.key, g.value #>> '{}'
  from planas, jsonb_each(dato) g where jsonb_typeof(dato) = 'object'
)
select bi.clave(a.envio_id::text, a.variable, coalesce(a.miembro::text, ''),
                coalesce(a.fila, ''), coalesce(a.valor, '')) as respuesta_id,
       a.envio_id,
       bi.clave(a.version_id::text, a.variable) as pregunta_id,
       a.version_id, a.variable,
       o.opcion_id,
       case when a.fila is not null then bi.clave(a.version_id::text, a.variable, a.fila) end
         as fila_id,
       a.miembro,
       a.valor,
       case when a.valor ~ '^-?\d+(\.\d+)?$' and o.especial is not true
            then a.valor::numeric end as valor_numero
from atomos a
left join bi.dim_opcion o
  on o.opcion_id = bi.clave(a.version_id::text, a.variable, a.valor)
with no data;
--> statement-breakpoint
-- ─── Flat ─────────────────────────────────────────────────────────────────────────────

create materialized view bi.plano_respuestas as
select org.organizacion, pr.proyecto_codigo, pr.proyecto,
       ins.instrumento_tipo, ins.instrumento, ve.version_numero,
       e.envio_id, ca.caso_codigo, pe.persona as entrevistador, pe.equipos,
       e.canal, cn.canal_nombre, e.estado, e.resultado, e.completa,
       e.fecha, fe.anio, fe.mes, fe.anio_mes, fe.semana_iso, fe.dia_nombre,
       e.enviado_en, e.segundos_activos, e.cara, e.referencia,
       r.variable, pg.pregunta, pg.tipo as pregunta_tipo, pg.lista, r.miembro,
       fi.fila, r.valor as codigo, coalesce(op.etiqueta, r.valor) as respuesta,
       op.especial as respuesta_especial, r.valor_numero,
       pg.orden as pregunta_orden, op.orden as opcion_orden
from bi.fact_respuesta r
join bi.fact_envio e on e.envio_id = r.envio_id
left join bi.dim_pregunta pg on pg.pregunta_id = r.pregunta_id
join bi.dim_version ve on ve.version_id = r.version_id
join bi.dim_instrumento ins on ins.instrumento_id = ve.instrumento_id
join bi.dim_proyecto pr on pr.proyecto_id = ins.proyecto_id
join bi.dim_organizacion org on org.organizacion_id = pr.organizacion_id
left join bi.dim_opcion op on op.opcion_id = r.opcion_id
left join bi.dim_fila fi on fi.fila_id = r.fila_id
left join bi.dim_caso ca on ca.caso_id = e.caso_id
left join bi.dim_persona pe on pe.persona_id = e.persona_id
left join bi.dim_canal cn on cn.canal = e.canal
left join bi.dim_fecha fe on fe.fecha = e.fecha
with no data;
--> statement-breakpoint
-- ─── Indexes and refresh ──────────────────────────────────────────────────────────────

create unique index on bi.dim_pregunta (pregunta_id);
--> statement-breakpoint
create index on bi.dim_pregunta (version_id, variable);
--> statement-breakpoint
create unique index on bi.dim_opcion (opcion_id);
--> statement-breakpoint
create index on bi.dim_opcion (pregunta_id);
--> statement-breakpoint
create unique index on bi.dim_fila (fila_id);
--> statement-breakpoint
create unique index on bi.fact_envio (envio_id);
--> statement-breakpoint
create index on bi.fact_envio (version_id);
--> statement-breakpoint
create index on bi.fact_envio (fecha);
--> statement-breakpoint
create unique index on bi.fact_respuesta (respuesta_id);
--> statement-breakpoint
create index on bi.fact_respuesta (envio_id);
--> statement-breakpoint
create index on bi.fact_respuesta (pregunta_id);
--> statement-breakpoint
create index on bi.fact_respuesta (opcion_id);
--> statement-breakpoint
create index on bi.plano_respuestas (proyecto_codigo, instrumento, variable);
--> statement-breakpoint
create index on bi.plano_respuestas (fecha);
--> statement-breakpoint
-- Recalculates everything, in order. Once filled, without blocking readers.
create or replace function bi.refrescar() returns void
language plpgsql security definer set search_path = bi, public as $$
declare v text;
begin
  foreach v in array array['dim_pregunta', 'dim_opcion', 'dim_fila', 'fact_envio',
                           'fact_respuesta', 'plano_respuestas'] loop
    if v <> 'plano_respuestas' and (select ispopulated from pg_matviews
                                    where schemaname = 'bi' and matviewname = v) then
      execute format('refresh materialized view concurrently bi.%I', v);
    else
      execute format('refresh materialized view bi.%I', v);
    end if;
  end loop;
end $$;
--> statement-breakpoint
revoke all on function bi.refrescar() from public;
--> statement-breakpoint
grant usage on schema bi to wansurvey_app;
--> statement-breakpoint
grant execute on function bi.refrescar() to wansurvey_app;
