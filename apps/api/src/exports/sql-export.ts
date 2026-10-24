import type { Column, ColumnSource, Table } from '@wansurvey/exporters';
import type { ExportBody } from './exports.service.js';
import { COUNTED_LIST } from '../common/statuses.js';

type Answer = Extract<ColumnSource, { kind: 'answer' }>;

/** What the query is for: the questionnaire, the version its labels come from, the options. */
export interface SqlExportInput {
  name: string;
  projectId: string;
  questionnaireId: string;
  /** The latest version: its variables are the columns, its labels the labels. */
  versionId: string;
  language: string;
  opts: ExportBody;
  main: Table;
  rosters: Table[];
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
/** Text for a `--` comment: one line, so nothing after it can become a statement. */
const comment = (s: string) => s.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ');

const META: Record<string, string> = {
  interview_id: 'e.envio_id::text',
  case_id: 'e.caso_id::text',
  case_code: 'ca.caso_codigo',
  mode: 'e.canal',
  status: 'e.estado',
  disposition: 'e.resultado',
  interviewer: 'pe.persona',
  started_at: `to_char(e.iniciado_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  submitted_at: `to_char(e.enviado_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
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
 * The SQL counterpart of the Excel export (format `sql`): a query per sheet over the analysis
 * model (schema bi, migrations 0034–0035) that gives the same columns, in the same order,
 * with the same cells for the same filters: codes or labels, wide or long rosters, paradata.
 * The columns come from the export's own table (`Column.source`), so both stay in step. The
 * views hold the data as of their last refresh (`select bi.refrescar()`).
 */
export function sqlExport(input: SqlExportInput): string {
  const { opts } = input;
  const labels = opts.labels === 'labels';
  const where = [
    `ve.instrumento_id = ${lit(input.questionnaireId)}`,
    `e.proyecto_id = ${lit(input.projectId)}`,
    // First keying only; returned and rejected interviews left out.
    'e.digitacion = 1',
    opts.approvedOnly ? `e.estado = 'approved'` : `e.estado in ${COUNTED_LIST}`,
    ...(opts.mode ? [`e.canal = ${lit(opts.mode)}`] : []),
    ...(opts.interviewerId ? [`e.persona_id = ${lit(opts.interviewerId)}`] : []),
    // Days in the project's time zone, as the export counts them.
    ...(opts.from ? [`e.fecha >= ${lit(opts.from)}::date`] : []),
    ...(opts.to ? [`e.fecha <= ${lit(opts.to)}::date`] : []),
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
    `where o.opcion_id = bi.clave(${lit(input.versionId)}, ${lit(variable)}, ${x}))`;

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
    const plainValue = (s: Answer) =>
      agg(`max(r.valor) filter (where ${at(s)} and r.fila_codigo is null and r.posicion is null)`);
    const coded = (s: Answer, x: string) =>
      labels ? `coalesce(${label(s.variable, x)}, ${x})` : `bi.numero(${x})`;

    const cell = (c: Column): string => {
      const s = c.source;
      if (!s) throw new Error(`Column ${c.name} has no source`);
      if (s.kind === 'meta') return META[s.field] ?? 'null';
      if (s.kind === 'paradata') return PARADATA[s.field] ?? 'null';
      if (s.kind === 'roster_row') return `split_part(a.ruta, '.', ${s.level})::int`;
      switch (s.read) {
        case 'code':
          return coded(s, plainValue(s));
        case 'text':
          return plainValue(s);
        case 'computed':
          return s.numeric ? `bi.numero(${plainValue(s)})` : `to_jsonb(${plainValue(s)})::text`;
        case 'other': {
          const x = plainValue(s);
          return `case when btrim(${x}) <> '' then ${x} end`;
        }
        case 'coded':
          return `bi.numero(${plainValue(s)})`;
        case 'rank':
          return coded(
            s,
            agg(
              `max(r.valor) filter (where ${at(s)} and (r.posicion = ${s.position} ` +
                `or (r.especial and r.posicion is null and r.fila_codigo is null)))`,
            ),
          );
        case 'grid':
          return coded(
            s,
            agg(
              `max(r.valor) filter (where ${at(s)} and (r.fila_codigo = ${lit(s.row!)} ` +
                `or (r.especial and r.posicion is null and r.fila_codigo is null)))`,
            ),
          );
        case 'dummy': {
          // Not answered: empty; a special answer: its code in every option; else 1 or 0.
          const n = agg(`count(*) filter (where ${at(s)})`);
          const sp = agg(
            `max(r.valor) filter (where ${at(s)} and r.especial and r.posicion is null)`,
          );
          const ticked = agg(
            `array_agg(r.valor) filter (where ${at(s)} and r.posicion is not null)`,
          );
          const hit = `${ticked} @> array[${lit(s.code!)}]`;
          return labels
            ? `case when ${n} = 0 then null when ${sp} is not null then coalesce(${label(s.variable, sp)}, ${sp}) when ${hit} then 'Sí' else 'No' end`
            : `case when ${n} = 0 then null when ${sp} is not null then bi.numero(${sp}) when ${hit} then 1 else 0 end`;
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
    return `with ${envios},
filas as (
  select r.envio_id, r.ruta${pivot.length ? ',\n' + pivot.join(',\n') : ''}
  from bi.fact_respuesta r
  join envios e on e.envio_id = r.envio_id
  where r.variable in (${inVars})
    and cardinality(string_to_array(r.ruta, '.')) = ${depth}
  group by r.envio_id, r.ruta
)
select
${columns.join(',\n')}
from filas a
join envios e on e.envio_id = a.envio_id
left join bi.dim_caso ca on ca.caso_id = e.caso_id
order by e.enviado_en, e.envio_id, string_to_array(a.ruta, '.')::int[];`;
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
    `-- Generado el ${new Date().toISOString()}. Las vistas muestran los datos de su último`,
    `-- refresco (cada hora en el worker, o: select bi.refrescar();). Ejecutar con un rol que`,
    `-- pueda leer el esquema bi.`,
  ].join('\n');
  const parts = [`${header}\n\n-- Hoja «data»\n${sheet(input.main, null)}`];
  for (const t of input.rosters) {
    const depth = t.columns.filter((c) => c.source?.kind === 'roster_row').length;
    parts.push(`-- Hoja «${comment(t.name)}»\n${sheet(t, depth)}`);
  }
  return parts.join('\n\n') + '\n';
}
