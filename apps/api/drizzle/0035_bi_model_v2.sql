-- Analysis model, second version: rebuilds schema bi (0034) with
--   * special answers ({"$special": "DK"}) as their codes, marked especial;
--   * rosters at any depth (ruta "2" or "2.1"), positions of ranked and ticked options, and a
--     marker for an answer given as an empty list;
--   * labels as plain text (tags dropped, piped values shown as …) and in every language
--     (*_i18n), scale points as options, the stratum on the case, personal questions flagged;
--   * paradata: fact_paradato (one row per event, joinable to the submission, the question
--     and the roster member) and its counts on fact_envio.
-- It also feeds the SQL export (exports/sql-export.ts), which rebuilds the Excel data sheet
-- of a questionnaire from these views. Grants given by hand on 0034's views must be repeated.
drop schema if exists bi cascade;
--> statement-breakpoint
create schema bi;
--> statement-breakpoint
-- A localised text in the language asked for, or the first one there is.
create function bi.texto(t jsonb, lang text) returns text
language sql immutable as $$
  select coalesce(t->>lang, (select value from jsonb_each_text(t) limit 1))
$$;
--> statement-breakpoint
-- Plain text of a label, as the exports write it: tags dropped, conditional blocks removed,
-- piped values (they differ per respondent) shown as …, whitespace collapsed.
create function bi.plano(t text) returns text
language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(t,
    '<[^>]+>', ' ', 'g'),
    '\{\{#if [^}]*\}\}|\{\{else\}\}|\{\{/if\}\}', '', 'g'),
    '\{\{[^}]*\}\}', '…', 'g'),
    '\s+', ' ', 'g'))
$$;
--> statement-breakpoint
-- A number written as text, or null (used by the SQL export to type coded columns).
create function bi.numero(t text) returns numeric
language sql immutable as $$
  select case when t ~ '^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$' then t::numeric end
$$;
--> statement-breakpoint
create function bi.clave(variadic partes text[]) returns text
language sql immutable as $$ select md5(array_to_string(partes, '|')) $$;
--> statement-breakpoint
-- ─── Hierarchy dimensions ─────────────────────────────────────────────────────────────

create view bi.dim_organizacion as
select id as organizacion_id, name as organizacion, slug
from tenants;
--> statement-breakpoint
create view bi.dim_proyecto as
select id as proyecto_id, tenant_id as organizacion_id, code as proyecto_codigo,
       name as proyecto, status as proyecto_estado, timezone as zona_horaria,
       created_at as creado_en
from projects;
--> statement-breakpoint
-- Questionnaires and feedback points, as one kind of "instrument".
create view bi.dim_instrumento as
select id as instrumento_id, project_id as proyecto_id, 'cuestionario' as instrumento_tipo,
       name as instrumento, state as instrumento_estado
from questionnaires
union all
select id, project_id, 'valoracion', name, case when active then 'active' else 'disabled' end
from feedback_points;
--> statement-breakpoint
create view bi.dim_version as
select v.id as version_id, v.questionnaire_id as instrumento_id, v.version as version_numero,
       v.published_at as publicada_en, v.retired_at as retirada_en,
       v.compiled->'questionnaire'->>'defaultLanguage' as idioma
from questionnaire_versions v
union all
-- A feedback point has one definition in force: its version is the point itself.
select p.id, p.id, p.version, p.created_at, null, 'es'
from feedback_points p;
--> statement-breakpoint
-- Every question of every version (also in groups and rosters), with its definition.
create view bi.preguntas_fuente as
select v.id as version_id, v.compiled->'questionnaire'->>'defaultLanguage' as lang,
       q->>'name' as variable, q, n as orden
from questionnaire_versions v,
     jsonb_path_query(v.compiled->'questionnaire'->'sections', 'strict $.**')
       with ordinality x(q, n)
where jsonb_typeof(q) = 'object' and q->>'kind' = 'question';
--> statement-breakpoint
-- Questions and computed variables. A feedback point's face and comment are _CARA and
-- _COMENTARIO (item ids start with a letter).
create materialized view bi.dim_pregunta as
with cuestionario as (
  select f.version_id, f.variable, f.q->>'type' as tipo, 'pregunta' as clase,
         f.q->'text' as pregunta_i18n, f.lang,
         array_to_string(array(select jsonb_array_elements_text(
           v.compiled->'vars'->f.variable->'rosterChain')), '.') as cadena,
         f.orden, coalesce((f.q->>'personal')::boolean, false) as personal
  from bi.preguntas_fuente f join questionnaire_versions v on v.id = f.version_id
  union all
  select v.id, x.key, x.value->>'type', x.value->>'kind', null,
         v.compiled->'questionnaire'->>'defaultLanguage',
         array_to_string(array(select jsonb_array_elements_text(x.value->'rosterChain')), '.'),
         100000, false
  from questionnaire_versions v, jsonb_each(v.compiled->'vars') x
  where x.value->>'kind' in ('computed', 'other')
),
valoracion as (
  select id as version_id, '_CARA' as variable, 'faces' as tipo, 'valoracion' as clase,
         question as pregunta_i18n, 'es' as lang, '' as cadena, 0::bigint as orden,
         false as personal
  from feedback_points
  union all
  select id, '_COMENTARIO', 'text', 'valoracion', '{"es": "Comentario"}'::jsonb, 'es', '',
         1000, false
  from feedback_points
  union all
  select p.id, it->>'id', it->>'type', 'valoracion', it->'text', 'es', '', 1 + n, false
  from feedback_points p, jsonb_array_elements(p.items) with ordinality x(it, n)
)
select bi.clave(version_id::text, variable) as pregunta_id, version_id, variable, tipo, clase,
       bi.plano(bi.texto(pregunta_i18n, lang)) as pregunta, pregunta_i18n,
       nullif(split_part(cadena, '.', -1), '') as lista, nullif(cadena, '') as cadena,
       orden, personal
from (select * from cuestionario union all select * from valoracion) t
with no data;
--> statement-breakpoint
-- Codes and labels: own options (or the shared answer set, or yes/no), scale points, special
-- codes (don't know, refused…) and the faces of feedback points.
create materialized view bi.dim_opcion as
with opciones as (
  select f.version_id, f.variable, o->>'code' as codigo, o->'label' as etiqueta_i18n, f.lang,
         false as especial, k as orden
  from bi.preguntas_fuente f
  join questionnaire_versions v on v.id = f.version_id,
       jsonb_array_elements(case
         when jsonb_array_length(coalesce(f.q->'options', '[]')) > 0 then f.q->'options'
         when f.q ? 'answerSetId'
           then v.compiled->'questionnaire'->'answerSets'->(f.q->>'answerSetId')
         when f.q->>'type' = 'yesno'
           then '[{"code": 1, "label": {"en": "Yes", "es": "Sí"}},
                  {"code": 2, "label": {"en": "No", "es": "No"}}]'::jsonb
         else '[]' end) with ordinality m(o, k)
  union all
  -- Likert and NPS points (not sliders, whole steps, at most 11 points): "1 – Muy malo" at
  -- the ends. offset 0 keeps the filter ahead of generate_series.
  select e.version_id, e.variable, p::text,
         case when p = e.lo and e.s ? 'minLabel' then
                (select jsonb_object_agg(l.key, p || ' – ' || bi.plano(l.value))
                 from jsonb_each_text(e.s->'minLabel') l)
              when p = e.hi and e.s ? 'maxLabel' then
                (select jsonb_object_agg(l.key, p || ' – ' || bi.plano(l.value))
                 from jsonb_each_text(e.s->'maxLabel') l)
              else jsonb_build_object(e.lang, p::text) end,
         e.lang, false, p
  from (select f.version_id, f.variable, f.lang, f.q->'scale' as s,
               (f.q->'scale'->>'min')::numeric::int as lo,
               (f.q->'scale'->>'max')::numeric::int as hi,
               coalesce((f.q->'scale'->>'step')::numeric, 1)::int as paso
        from bi.preguntas_fuente f
        where f.q->>'type' = 'scale' and f.q->'scale'->>'style' <> 'slider'
          and coalesce((f.q->'scale'->>'step')::numeric, 1) > 0
          and coalesce((f.q->'scale'->>'step')::numeric, 1)
              = trunc(coalesce((f.q->'scale'->>'step')::numeric, 1))
          and ((f.q->'scale'->>'max')::numeric - (f.q->'scale'->>'min')::numeric)
              / coalesce((f.q->'scale'->>'step')::numeric, 1) < 11
        offset 0) e,
       generate_series(e.lo, e.hi, e.paso) p
  union all
  select f.version_id, f.variable, sp.value->>'code', sp.value->'label', f.lang, true, 1000
  from bi.preguntas_fuente f
  join questionnaire_versions v on v.id = f.version_id,
       jsonb_each(v.compiled->'questionnaire'->'settings'->'specialCodes') sp
  where f.q->>'type' in ('single', 'multi', 'yesno', 'numeric', 'grid', 'scale', 'ranking')
  union all
  select f.id, '_CARA', c::text,
         jsonb_build_object('es', (case when f.faces = 5
           then array['Muy mal', 'Mal', 'Regular', 'Bien', 'Muy bien']
           else array['Mal', 'Regular', 'Bien'] end)[c]), 'es', false, c
  from feedback_points f, generate_series(1, f.faces) c
  union all
  select f.id, it->>'id', o->>'code', o->'label', 'es', false, k
  from feedback_points f, jsonb_array_elements(f.items) it,
       jsonb_array_elements(case when it->>'type' = 'yesno'
         then '[{"code": 1, "label": {"es": "Sí"}}, {"code": 2, "label": {"es": "No"}}]'::jsonb
         else coalesce(it->'options', '[]') end) with ordinality m(o, k)
)
select distinct on (version_id, variable, codigo)
       bi.clave(version_id::text, variable, codigo) as opcion_id,
       bi.clave(version_id::text, variable) as pregunta_id,
       codigo, bi.plano(bi.texto(etiqueta_i18n, lang)) as etiqueta, etiqueta_i18n,
       especial, orden
from opciones
order by version_id, variable, codigo, especial
with no data;
--> statement-breakpoint
-- Grid rows (D6_GRID → a, b, c).
create materialized view bi.dim_fila as
select bi.clave(f.version_id::text, f.variable, r->>'code') as fila_id,
       bi.clave(f.version_id::text, f.variable) as pregunta_id,
       r->>'code' as fila_codigo, bi.plano(bi.texto(r->'label', f.lang)) as fila,
       r->'label' as fila_i18n, n as orden
from bi.preguntas_fuente f, jsonb_array_elements(f.q->'rows') with ordinality g(r, n)
where f.q ? 'rows'
with no data;
--> statement-breakpoint
-- ─── Other dimensions ─────────────────────────────────────────────────────────────────

-- Cases without personal data (that stays sealed).
create view bi.dim_caso as
select c.id as caso_id, c.project_id as proyecto_id, c.questionnaire_id as instrumento_id,
       c.external_id as caso_codigo, c.status as caso_estado, c.disposition as caso_resultado,
       c.selection_role as rol_seleccion, fu.stratum as estrato,
       c.inclusion_prob as prob_inclusion, c.base_weight as peso_base, c.sample as muestra
from cases c left join frame_units fu on fu.id = c.frame_unit_id;
--> statement-breakpoint
create view bi.dim_persona as
select u.id as persona_id, u.name as persona,
       (select string_agg(t.name, ', ' order by t.name)
        from team_members m join teams t on t.id = m.team_id
        where m.user_id = u.id) as equipos
from users u;
--> statement-breakpoint
create view bi.dim_canal as
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
-- The kinds of paradata event.
create view bi.dim_evento as
select * from (values
  ('enter_question', 'Entra a una pregunta', 'navegacion'),
  ('leave_question', 'Sale de una pregunta', 'navegacion'),
  ('navigate_back', 'Retrocede', 'navegacion'),
  ('pause', 'Pausa', 'sesion'),
  ('resume', 'Reanuda', 'sesion'),
  ('focus_lost', 'Deja la ventana', 'sesion'),
  ('focus_gained', 'Vuelve a la ventana', 'sesion'),
  ('sync', 'Sincroniza', 'sesion'),
  ('language_switch', 'Cambia de idioma', 'sesion'),
  ('warning_confirmed', 'Confirma una advertencia', 'calidad'),
  ('answers_cleared', 'Respuestas borradas por un cambio de ruta', 'calidad'),
  ('note_added', 'Agrega una nota', 'calidad'),
  ('gps', 'Ubicación del dispositivo', 'ubicacion'),
  ('paper_meta', 'Fecha y duración escritas en el papel', 'papel')
) e(tipo, evento, grupo);
--> statement-breakpoint
create view bi.dim_fecha as
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

-- A submission: an interview (any mode, any keying) or a feedback response, with its
-- paradata counts and review flags (as the export's paradata columns).
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
       case when i.disposition = 'COMPLETE' then 1 else 0 end as completa,
       coalesce(pd.retrocesos, 0) as retrocesos, coalesce(pd.notas, 0) as notas,
       coalesce(pd.pausas, 0) as pausas, coalesce(pd.advertencias, 0) as advertencias,
       (select string_agg(k, ' ' order by k collate "C") from jsonb_object_keys(i.flags) k)
         as alertas
from interviews i
join projects p on p.id = i.project_id
left join (
  select interview_id,
         count(*) filter (where type = 'navigate_back')::int as retrocesos,
         count(*) filter (where type = 'note_added')::int as notas,
         count(*) filter (where type = 'pause')::int as pausas,
         count(*) filter (where type = 'warning_confirmed')::int as advertencias
  from interview_paradata group by interview_id
) pd on pd.interview_id = i.id
union all
select r.id, r.point_id, f.project_id, null, null, r.channel,
       (r.created_at at time zone p.timezone)::date, r.created_at, r.created_at,
       'submitted', 'COMPLETE', null, null, false, null, null,
       r.score, r.ref, 1, 0, 0, 0, 0, null
from feedback_responses r
join feedback_points f on f.id = r.point_id
join projects p on p.id = f.project_id
with no data;
--> statement-breakpoint
-- One atomic answer: a value, a ticked or ranked option (posicion), a grid row (fila), at
-- any roster depth (ruta "2" is the second member, "2.1" the first row inside it). An answer
-- given as an empty list is one row with no valor. Special answers carry their code and
-- especial = true; valor_numero leaves them out, so sums and means count real answers only.
create materialized view bi.fact_respuesta as
with recursive niveles(envio_id, version_id, ruta, obj) as (
  select i.id, i.questionnaire_version_id, ''::text, i.answers from interviews i
  union all
  select n.envio_id, n.version_id,
         case when n.ruta = '' then m.k::text else n.ruta || '.' || m.k end, m.fila
  from niveles n, jsonb_each(n.obj) a,
       jsonb_array_elements(a.value) with ordinality m(fila, k)
  where jsonb_typeof(a.value) = 'array' and jsonb_typeof(m.fila) = 'object'
),
especiales as (
  select v.id as version_id, s.key as clase, s.value->>'code' as codigo
  from questionnaire_versions v,
       jsonb_each(v.compiled->'questionnaire'->'settings'->'specialCodes') s
),
planas as (
  select n.envio_id, n.version_id, n.ruta, a.key as variable, a.value as dato
  from niveles n, jsonb_each(n.obj) a
  -- Roster lists are walked above, not answers.
  where not (jsonb_typeof(a.value) = 'array'
             and jsonb_path_exists(a.value, '$[*] ? (@.type() == "object")'))
  union all
  select r.id, r.point_id, '', '_CARA', to_jsonb(r.score) from feedback_responses r
  union all
  select r.id, r.point_id, '', '_COMENTARIO', to_jsonb(r.comment)
  from feedback_responses r where r.comment is not null
  union all
  select r.id, r.point_id, '', a.key, a.value
  from feedback_responses r, jsonb_each(coalesce(r.answers, '{}')) a
),
-- An answer value as text: a special one as its code.
atomos as (
  select envio_id, version_id, ruta, variable, null::text as fila, null::int as posicion,
         dato as v
  from planas where jsonb_typeof(dato) in ('number', 'string', 'boolean')
                 or (jsonb_typeof(dato) = 'object' and dato ? '$special')
  union all
  select envio_id, version_id, ruta, variable, null, k::int, e
  from planas, jsonb_array_elements(dato) with ordinality x(e, k)
  where jsonb_typeof(dato) = 'array'
  union all
  select envio_id, version_id, ruta, variable, null, null, null
  from planas where jsonb_typeof(dato) = 'array' and jsonb_array_length(dato) = 0
  union all
  select envio_id, version_id, ruta, variable, g.key, null, g.value
  from planas, jsonb_each(dato) g
  where jsonb_typeof(dato) = 'object' and not dato ? '$special'
),
valores as (
  select a.envio_id, a.version_id, a.ruta, a.variable, a.fila, a.posicion,
         case when jsonb_typeof(a.v) = 'object' and a.v ? '$special' then s.codigo
              when jsonb_typeof(a.v) in ('object', 'array') then a.v::text
              else a.v #>> '{}' end as valor,
         coalesce(jsonb_typeof(a.v) = 'object' and a.v ? '$special', false) as especial,
         case when jsonb_typeof(a.v) = 'object' and a.v ? '$special' then a.v->>'$special' end
           as especial_clase
  from atomos a
  left join especiales s
    on s.version_id = a.version_id and s.clase = a.v->>'$special'
       and jsonb_typeof(a.v) = 'object'
)
select bi.clave(a.envio_id::text, a.variable, a.ruta, coalesce(a.fila, ''),
                coalesce(a.posicion::text, ''), coalesce(a.valor, '')) as respuesta_id,
       a.envio_id,
       bi.clave(a.version_id::text, a.variable) as pregunta_id,
       a.version_id, a.variable,
       o.opcion_id,
       case when a.fila is not null then bi.clave(a.version_id::text, a.variable, a.fila) end
         as fila_id,
       nullif(a.ruta, '') as ruta,
       nullif(split_part(a.ruta, '.', 1), '')::int as miembro,
       a.fila as fila_codigo,
       a.posicion,
       a.valor,
       a.especial or coalesce(o.especial, false) as especial,
       a.especial_clase,
       case when a.valor ~ '^-?\d+(\.\d+)?$' and not a.especial
                 and not coalesce(o.especial, false)
            then a.valor::numeric end as valor_numero
from valores a
left join bi.dim_opcion o
  on o.opcion_id = bi.clave(a.version_id::text, a.variable, a.valor)
with no data;
--> statement-breakpoint
-- One paradata event, joinable to its submission (envio_id), the question it is about
-- (pregunta_id) and the roster member (ruta), like the answers.
create materialized view bi.fact_paradato as
with eventos as (
  select pd.*, i.questionnaire_version_id as version_id, p.timezone,
         coalesce(pd.payload->>'key', pd.payload->>'from') as clave_posicion
  from interview_paradata pd
  join interviews i on i.id = pd.interview_id
  join projects p on p.id = i.project_id
)
select e.id as paradato_id, e.interview_id as envio_id, e.version_id, e.type as tipo,
       e.at as en, (e.at at time zone e.timezone)::date as fecha,
       e.device_id as dispositivo, e.seq as secuencia, e.monotonic_ms as ms_monotono,
       e.clave_posicion,
       case when e.clave_posicion is not null then bi.clave(e.version_id::text,
         regexp_replace(regexp_replace(e.clave_posicion, '^.*\.', ''), '(\[\d+\])+$', ''))
       end as pregunta_id,
       regexp_replace(regexp_replace(e.clave_posicion, '^.*\.', ''), '(\[\d+\])+$', '')
         as variable,
       nullif(array_to_string(array(
         select (regexp_matches(e.clave_posicion, '\[(\d+)\]', 'g'))[1]), '.'), '') as ruta,
       e.payload->>'to' as destino,
       round(coalesce(e.payload->>'ms', e.payload->>'hiddenMs')::numeric / 1000.0, 1)
         as segundos,
       (e.payload->>'lat')::numeric as latitud, (e.payload->>'lng')::numeric as longitud,
       (e.payload->>'accuracy')::numeric as precision_m,
       e.payload->>'when' as momento,
       e.payload->>'text' as nota,
       e.payload
from eventos e
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
       e.retrocesos, e.notas, e.pausas, e.advertencias, e.alertas,
       r.variable, pg.pregunta, pg.tipo as pregunta_tipo, pg.lista, pg.personal,
       r.ruta, r.miembro, fi.fila, r.posicion,
       r.valor as codigo, coalesce(op.etiqueta, r.valor) as respuesta,
       r.especial as respuesta_especial, r.valor_numero,
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
create index on bi.fact_respuesta (envio_id, variable);
--> statement-breakpoint
create index on bi.fact_respuesta (pregunta_id);
--> statement-breakpoint
create index on bi.fact_respuesta (opcion_id);
--> statement-breakpoint
create unique index on bi.fact_paradato (paradato_id);
--> statement-breakpoint
create index on bi.fact_paradato (envio_id);
--> statement-breakpoint
create index on bi.fact_paradato (pregunta_id);
--> statement-breakpoint
create index on bi.plano_respuestas (proyecto_codigo, instrumento, variable);
--> statement-breakpoint
create index on bi.plano_respuestas (fecha);
--> statement-breakpoint
-- Recalculates everything, in order. Once filled, without blocking readers.
create function bi.refrescar() returns void
language plpgsql security definer set search_path = bi, public as $$
declare v text;
begin
  foreach v in array array['dim_pregunta', 'dim_opcion', 'dim_fila', 'fact_envio',
                           'fact_respuesta', 'fact_paradato', 'plano_respuestas'] loop
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
