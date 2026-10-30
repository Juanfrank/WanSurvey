import type { Column, ColumnSource, Table } from '@wansurvey/exporters';
import type { SqlExportInput } from './sql-export.js';
import { COUNTED_LIST } from '../common/statuses.js';

type Answer = Extract<ColumnSource, { kind: 'answer' }>;

const lit = (s: string) => `N'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `[${s.replace(/]/g, ']]')}]`;
/** Text for a `--` comment: one line, so nothing after it can become a statement. */
const comment = (s: string) => s.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ');
/** Ids are keyed in lower case in the model. */
const id = (s: string) => lit(s.toLowerCase());
const iso = (col: string) => {
  const t = `cast(switchoffset(${col}, '+00:00') as datetime2(3))`;
  return `case when ${col} is null then null else convert(varchar(19), ${t}, 126) + '.' + right('000' + cast(datepart(millisecond, ${t}) as varchar(3)), 3) + 'Z' end`;
};
const guid = (col: string) => `lower(convert(varchar(36), ${col}))`;

const META: Record<string, string> = {
  interview_id: guid('e.envio_id'),
  case_id: guid('e.caso_id'),
  case_code: 'ca.caso_codigo',
  mode: 'e.canal',
  status: 'e.estado',
  disposition: 'e.resultado',
  interviewer: 'pe.persona',
  started_at: iso('e.iniciado_en'),
  submitted_at: iso('e.enviado_en'),
  active_seconds: 'e.segundos_activos',
  version: 'e.version_numero',
  language: 'e.idioma',
  selection_role: 'ca.rol_seleccion',
  stratum: 'ca.estrato',
  inclusion_prob: 'ca.prob_inclusion',
  base_weight: 'ca.peso_base',
};
const PARADATA: Record<string, string> = {
  back_moves: 'e.retrocesos',
  notes: 'e.notas',
  pauses: 'e.pausas',
  warnings_confirmed: 'e.advertencias',
  flags: 'e.alertas',
};

/**
 * The T-SQL counterpart of `sqlExport` (format `sql` on SQL Server): a query per sheet over the
 * analysis model (schema bi, mssql/0009) that gives the same columns, in the same order, with
 * the same cells for the same filters: codes or labels, wide or long rosters, paradata. The
 * columns come from the export's own table (`Column.source`), so both stay in step. The tables
 * hold the data as of their last refresh (`EXEC bi.refrescar;`).
 */
export function sqlExportMssql(input: SqlExportInput): string {
  const { opts } = input;
  const labels = opts.labels === 'labels';
  const where = [
    `ve.instrumento_id = ${id(input.questionnaireId)}`,
    `e.proyecto_id = ${id(input.projectId)}`,
    // First keying only; returned and rejected interviews left out.
    'e.digitacion = 1',
    opts.approvedOnly ? `e.estado = 'approved'` : `e.estado in ${COUNTED_LIST}`,
    ...(opts.mode ? [`e.canal = ${lit(opts.mode)}`] : []),
    ...(opts.interviewerId ? [`e.persona_id = ${id(opts.interviewerId)}`] : []),
    // Days in the project's time zone, as the export counts them.
    ...(opts.from ? [`e.fecha >= cast(${lit(opts.from)} as date)`] : []),
    ...(opts.to ? [`e.fecha <= cast(${lit(opts.to)} as date)`] : []),
  ];
  const envios = `envios as (
  select e.*, ve.version_numero
  from bi.fact_envio e
  join bi.dim_version ve on ve.version_id = e.version_id
  where ${where.join('\n    and ')}
)`;

  // The label of a code of a variable, in the export's language.
  const label = (variable: string, x: string) =>
    `(select bi.plano(bi.texto(o.etiqueta_i18n, ${lit(input.language)})) from bi.dim_opcion o ` +
    `where o.opcion_id = bi.clave(concat(${id(input.versionId)}, N'|', ${lit(variable)}, N'|', ${x})))`;

  /** The query of one sheet: its answers pivoted per submission (or per roster row). */
  const sheet = (table: Table, depth: number | null) => {
    const aggs = new Map<string, string>();
    const agg = (expr: string) => {
      const known = [...aggs].find(([, e]) => e === expr);
      if (known) return `a.${known[0]}`;
      const alias = `v${aggs.size + 1}`;
      aggs.set(alias, expr);
      return `a.${alias}`;
    };
    const at = (s: Answer) =>
      [
        `r.variable = ${lit(s.variable)}`,
        // Wide roster columns name their row; a long sheet has one row per group.
        ...(depth === null
          ? [s.path ? `r.ruta = ${lit(s.path.join('.'))}` : 'r.ruta is null']
          : []),
      ].join(' and ');
    const max = (cond: string) => `max(case when ${cond} then r.valor end)`;
    const plainValue = (s: Answer) =>
      agg(max(`${at(s)} and r.fila_codigo is null and r.posicion is null`));
    const coded = (s: Answer, x: string) =>
      labels ? `coalesce(${label(s.variable, x)}, ${x})` : `bi.numero(${x})`;

    const cell = (c: Column): string => {
      const s = c.source;
      if (!s) throw new Error(`Column ${c.name} has no source`);
      if (s.kind === 'meta') return META[s.field] ?? 'null';
      if (s.kind === 'paradata') return PARADATA[s.field] ?? 'null';
      if (s.kind === 'roster_row')
        return `cast(json_value('[' + replace(a.ruta, '.', ',') + ']', '$[${s.level - 1}]') as int)`;
      switch (s.read) {
        case 'code':
          return coded(s, plainValue(s));
        case 'text':
          return plainValue(s);
        case 'computed': {
          const x = plainValue(s);
          return s.numeric
            ? `bi.numero(${x})`
            : `case when ${x} is null then null else '"' + string_escape(${x}, 'json') + '"' end`;
        }
        case 'other': {
          const x = plainValue(s);
          return `case when ltrim(rtrim(${x})) <> '' then ${x} end`;
        }
        case 'coded':
          return `bi.numero(${plainValue(s)})`;
        case 'rank':
          return coded(
            s,
            agg(
              max(
                `${at(s)} and (r.posicion = ${s.position} ` +
                  `or (r.especial = 1 and r.posicion is null and r.fila_codigo is null))`,
              ),
            ),
          );
        case 'grid':
          return coded(
            s,
            agg(
              max(
                `${at(s)} and (r.fila_codigo = ${lit(s.row!)} ` +
                  `or (r.especial = 1 and r.posicion is null and r.fila_codigo is null))`,
              ),
            ),
          );
        case 'dummy': {
          // Not answered: empty; a special answer: its code in every option; else 1 or 0.
          const n = agg(`sum(case when ${at(s)} then 1 else 0 end)`);
          const sp = agg(max(`${at(s)} and r.especial = 1 and r.posicion is null`));
          const hit = agg(
            `sum(case when ${at(s)} and r.posicion is not null and r.valor = ${lit(s.code!)} then 1 else 0 end)`,
          );
          return labels
            ? `case when ${n} = 0 then null when ${sp} is not null then coalesce(${label(s.variable, sp)}, ${sp}) when ${hit} > 0 then N'Sí' else N'No' end`
            : `case when ${n} = 0 then null when ${sp} is not null then bi.numero(${sp}) when ${hit} > 0 then 1 else 0 end`;
        }
      }
    };

    const columns = table.columns.map((c) => `  ${cell(c)} as ${ident(c.name)}`);
    const variables = [
      ...new Set(
        table.columns.flatMap((c) => (c.source?.kind === 'answer' ? [c.source.variable] : [])),
      ),
    ];
    const pivot = [...aggs].map(([alias, e]) => `    ${e} as ${alias}`);
    const inVars = variables.length ? variables.map(lit).join(', ') : 'null';
    if (depth === null)
      return `with ${envios},
respuestas as (
  select r.envio_id${pivot.length ? ',\n' + pivot.join(',\n') : ''}
  from bi.fact_respuesta r
  join envios e on e.envio_id = r.envio_id
  where r.variable in (${inVars})
  group by r.envio_id
)
select
${columns.join(',\n')}
from envios e
left join respuestas a on a.envio_id = e.envio_id
left join bi.dim_caso ca on ca.caso_id = e.caso_id
left join bi.dim_persona pe on pe.persona_id = e.persona_id
  and pe.organizacion_id = (select pr.organizacion_id from bi.dim_proyecto pr
                            where pr.proyecto_id = e.proyecto_id)
order by e.enviado_en, e.envio_id;`;
    const levels = Array.from(
      { length: depth },
      (_, i) => `cast(json_value('[' + replace(a.ruta, '.', ',') + ']', '$[${i}]') as int)`,
    );
    return `with ${envios},
filas as (
  select r.envio_id, r.ruta${pivot.length ? ',\n' + pivot.join(',\n') : ''}
  from bi.fact_respuesta r
  join envios e on e.envio_id = r.envio_id
  where r.variable in (${inVars})
    and len(r.ruta) - len(replace(r.ruta, '.', '')) + 1 = ${depth}
  group by r.envio_id, r.ruta
)
select
${columns.join(',\n')}
from filas a
join envios e on e.envio_id = a.envio_id
left join bi.dim_caso ca on ca.caso_id = e.caso_id
order by e.enviado_en, e.envio_id, ${levels.join(', ')};`;
  };

  const filters = [
    opts.mode && `modo ${opts.mode}`,
    opts.interviewerId && `entrevistador ${opts.interviewerId}`,
    opts.from && `desde ${opts.from}`,
    opts.to && `hasta ${opts.to}`,
    opts.approvedOnly && 'solo aprobadas',
  ].filter(Boolean);
  const header = [
    `-- WanSurvey · ${comment(input.name)}`,
    `-- La misma tabla que la exportación a Excel, leída del modelo de análisis (esquema bi).`,
    `-- Cuestionario ${input.questionnaireId}, variables y etiquetas de la versión ${input.versionId}.`,
    `-- Opciones: ${labels ? 'etiquetas' : 'códigos'}, listas ${opts.rosters === 'wide' ? 'en columnas' : 'en tablas aparte'}, ${opts.paradata ? 'con' : 'sin'} paradatos, idioma ${input.language}.`,
    `-- Filtros: ${filters.length ? filters.join(', ') : 'ninguno'}.`,
    `-- Generado el ${new Date().toISOString()}. Las tablas muestran los datos de su último`,
    `-- refresco (cada hora en el worker, o: EXEC bi.refrescar;). Ejecutar con un rol que`,
    `-- pueda leer el esquema bi. T-SQL (SQL Server, Azure SQL).`,
  ].join('\n');
  const parts = [`${header}\n\n-- Hoja «data»\n${sheet(input.main, null)}`];
  for (const t of input.rosters) {
    const depth = t.columns.filter((c) => c.source?.kind === 'roster_row').length;
    parts.push(`-- Hoja «${comment(t.name)}»\n${sheet(t, depth)}`);
  }
  return parts.join('\n\n') + '\n';
}
