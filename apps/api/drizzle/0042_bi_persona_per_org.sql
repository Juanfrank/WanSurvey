-- A person's teams in the analysis model are those of the organisation the data belongs to.
-- An account can belong to several organisations, so bi.dim_persona has one row per person
-- and organisation (organizacion_id added at the end; the other columns are as before) and
-- the views that join it match the organisation too.
drop materialized view if exists bi.plano_respuestas;
--> statement-breakpoint
create or replace view bi.dim_persona as
select u.id as persona_id, u.name as persona,
       (select string_agg(t.name, ', ' order by t.name)
        from team_members m join teams t on t.id = m.team_id
        where m.user_id = u.id and t.tenant_id = tm.tenant_id) as equipos,
       tm.tenant_id as organizacion_id
from users u
join tenant_members tm on tm.user_id = u.id;
--> statement-breakpoint
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
                           and pe.organizacion_id = pr.organizacion_id
left join bi.dim_canal cn on cn.canal = e.canal
left join bi.dim_fecha fe on fe.fecha = e.fecha
with no data;
--> statement-breakpoint
create index on bi.plano_respuestas (proyecto_codigo, instrumento, variable);
--> statement-breakpoint
create index on bi.plano_respuestas (fecha);
--> statement-breakpoint
-- Filled again now when the model already was; otherwise by the next refresh, which runs
-- whatever the fingerprint says.
DO $$
BEGIN
  IF (select ispopulated from pg_catalog.pg_matviews
      where schemaname = 'bi' and matviewname = 'fact_respuesta') THEN
    REFRESH MATERIALIZED VIEW bi.plano_respuestas;
  END IF;
END $$;
--> statement-breakpoint
DELETE FROM bi.estado WHERE clave = 'huella';
