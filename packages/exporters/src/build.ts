import { questionOptions, type CompiledQuestionnaire } from '@wansurvey/logic';
import type { LocalizedText, Question } from '@wansurvey/schema';
import type { Cell, Column, Table } from './table.js';

/** One interview as the export reads it. */
export interface ExportInterview {
  id: string;
  caseId: string | null;
  mode: string;
  status: string;
  disposition: string | null;
  interviewer: string | null;
  startedAt: Date | string;
  submittedAt: Date | string | null;
  activeMs: number;
  version: number;
  language: string;
  answers: Record<string, unknown>;
  /** Counts from paradata, when the export includes it. */
  paradata?: { backMoves: number; notes: number; pauses: number; warnings: number };
  flags?: Record<string, unknown>;
}

export interface BuildOptions {
  /** wide: roster answers as numbered columns; long: a table per roster. */
  rosters: 'wide' | 'long';
  paradata: boolean;
  /** Language of labels; the questionnaire's default when left out. */
  language?: string;
}

type Special = { $special: string };
const isSpecial = (v: unknown): v is Special =>
  !!v && typeof v === 'object' && !Array.isArray(v) && '$special' in v;

/** Plain text of a label: tags stripped, pipes kept as «name», whitespace collapsed. */
function plain(text: LocalizedText | undefined, lang: string, fallback: string): string {
  const t = text?.[lang] ?? (text ? Object.values(text)[0] : undefined) ?? fallback;
  return t
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\{#if [^}]*\}\}|\{\{else\}\}|\{\{\/if\}\}/g, '')
    .replace(
      /\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g,
      (_m, e: string) => `«${e.replace(/^roster\./, '')}»`,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** How to turn one variable's answer into cells: its columns and a reader. */
interface Field {
  /** The answer key it reads. */
  source: string;
  /** Roster names from the outermost in. */
  chain: string[];
  columns: Column[];
  cells(value: unknown): Cell[];
}

const numericCodes = (codes: (string | number)[]) => codes.every((c) => typeof c === 'number');

function fieldsOf(compiled: CompiledQuestionnaire, lang: string): Field[] {
  const q = compiled.questionnaire;
  const special = q.settings.specialCodes;
  const specialCode = (kind: string) =>
    (special as Record<string, { code: number } | undefined>)[kind]?.code ?? null;
  const specialLabels = new Map<number, string>();
  for (const s of Object.values(special))
    if (typeof s.code === 'number') specialLabels.set(s.code, plain(s.label, lang, String(s.code)));
  const missing = [...specialLabels.keys()];
  const fields: Field[] = [];
  for (const node of compiled.nodes) {
    if (node.kind !== 'question' && node.kind !== 'computed') continue;
    const name = (node.def as { name?: string }).name;
    if (!name) continue;
    const info = compiled.vars[name];
    const chain = info?.rosterChain ?? [];
    if (node.kind === 'computed') {
      const numeric = info?.type === 'number' || info?.type === 'code';
      fields.push({
        source: name,
        chain,
        columns: [{ name, label: name, type: numeric ? 'numeric' : 'string' }],
        cells: (v) => [
          v === null || v === undefined ? null : numeric ? Number(v) : JSON.stringify(v),
        ],
      });
      continue;
    }
    const def = node.def as Question;
    const label = plain(def.text, lang, name);
    const opts = questionOptions(def, q);
    const optLabels = new Map<number, string>(specialLabels);
    for (const o of opts)
      if (typeof o.code === 'number') optLabels.set(o.code, plain(o.label, lang, String(o.code)));
    const code = (v: unknown): Cell => {
      if (v === null || v === undefined) return null;
      if (isSpecial(v)) return specialCode(v.$special);
      return typeof v === 'number' ? v : Number.isFinite(Number(v)) ? Number(v) : String(v);
    };
    switch (def.type) {
      case 'single':
      case 'yesno': {
        const numeric = numericCodes(opts.map((o) => o.code));
        fields.push({
          source: name,
          chain,
          columns: [
            numeric
              ? {
                  name,
                  label,
                  type: 'numeric',
                  valueLabels: optLabels,
                  missing,
                  measure: 'nominal',
                }
              : { name, label, type: 'string' },
          ],
          cells: (v) => [
            numeric
              ? code(v)
              : v === null || v === undefined
                ? null
                : isSpecial(v)
                  ? String(specialCode(v.$special))
                  : String(v),
          ],
        });
        break;
      }
      case 'multi': {
        const dummies = new Map<number, string>([[0, 'No'], [1, 'Sí'], ...specialLabels]);
        fields.push({
          source: name,
          chain,
          columns: opts.map((o) => ({
            name: `${name}_${String(o.code).replace(/[^A-Za-z0-9]/g, '_')}`,
            label: `${label}: ${plain(o.label, lang, String(o.code))}`,
            type: 'numeric' as const,
            valueLabels: dummies,
            missing,
            measure: 'nominal' as const,
            group: { name, label },
          })),
          cells: (v) =>
            opts.map((o) => {
              if (v === null || v === undefined) return null;
              if (isSpecial(v)) return specialCode(v.$special);
              return Array.isArray(v) && v.some((x) => String(x) === String(o.code)) ? 1 : 0;
            }),
        });
        break;
      }
      case 'ranking': {
        fields.push({
          source: name,
          chain,
          columns: opts.map((_, i) => ({
            name: `${name}_${i + 1}`,
            label: `${label} (${i + 1})`,
            type: 'numeric' as const,
            valueLabels: optLabels,
            missing,
            measure: 'nominal' as const,
          })),
          cells: (v) =>
            opts.map((_, i) =>
              isSpecial(v) ? specialCode(v.$special) : Array.isArray(v) ? code(v[i]) : null,
            ),
        });
        break;
      }
      case 'grid': {
        const rows = def.rows ?? [];
        fields.push({
          source: name,
          chain,
          columns: rows.map((r) => ({
            name: `${name}_${String(r.code).replace(/[^A-Za-z0-9]/g, '_')}`,
            label: `${label}: ${plain(r.label, lang, String(r.code))}`,
            type: 'numeric' as const,
            valueLabels: optLabels,
            missing,
            measure: 'ordinal' as const,
          })),
          cells: (v) =>
            rows.map((r) =>
              isSpecial(v)
                ? specialCode(v.$special)
                : v && typeof v === 'object'
                  ? code((v as Record<string, unknown>)[String(r.code)])
                  : null,
            ),
        });
        break;
      }
      case 'numeric':
      case 'scale':
        fields.push({
          source: name,
          chain,
          columns: [
            { name, label, type: 'numeric', valueLabels: specialLabels, missing, measure: 'scale' },
          ],
          cells: (v) => [code(v)],
        });
        break;
      default:
        fields.push({
          source: name,
          chain,
          columns: [{ name, label, type: 'string' }],
          cells: (v) => [
            v === null || v === undefined
              ? null
              : isSpecial(v)
                ? String(specialCode(v.$special))
                : typeof v === 'object'
                  ? JSON.stringify(v)
                  : String(v),
          ],
        });
    }
    // "Other, specify" text and its code from coding (R6).
    if (opts.some((o) => o.otherSpecify)) {
      fields.push({
        source: `${name}_OTHER`,
        chain,
        columns: [{ name: `${name}_OTHER`, label: `${label} (otro)`, type: 'string' }],
        cells: (v) => [typeof v === 'string' && v.trim() ? v : null],
      });
    }
  }
  return fields;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

const META: Column[] = [
  { name: 'interview_id', label: 'Interview id', type: 'string' },
  { name: 'case_id', label: 'Case id', type: 'string' },
  { name: 'mode', label: 'Mode', type: 'string' },
  { name: 'status', label: 'Status', type: 'string' },
  { name: 'disposition', label: 'Disposition', type: 'string' },
  { name: 'interviewer', label: 'Interviewer', type: 'string' },
  { name: 'started_at', label: 'Start (UTC)', type: 'string' },
  { name: 'submitted_at', label: 'Submitted (UTC)', type: 'string' },
  { name: 'active_seconds', label: 'Active time (seconds)', type: 'numeric', measure: 'scale' },
  { name: 'version', label: 'Questionnaire version', type: 'numeric', measure: 'ordinal' },
  { name: 'language', label: 'Language', type: 'string' },
];
const PARADATA: Column[] = [
  { name: 'back_moves', label: 'Back moves', type: 'numeric', measure: 'scale' },
  { name: 'notes', label: 'Notes added', type: 'numeric', measure: 'scale' },
  { name: 'pauses', label: 'Pauses', type: 'numeric', measure: 'scale' },
  {
    name: 'warnings_confirmed',
    label: 'Soft warnings confirmed',
    type: 'numeric',
    measure: 'scale',
  },
  { name: 'flags', label: 'Review flags', type: 'string' },
];

function meta(i: ExportInterview): Cell[] {
  return [
    i.id,
    i.caseId,
    i.mode,
    i.status,
    i.disposition,
    i.interviewer,
    iso(i.startedAt),
    iso(i.submittedAt),
    Math.round(i.activeMs / 1000),
    i.version,
    i.language,
  ];
}

/** Rows of a roster (by chain) inside one interview's answers, with their 1-based indexes. */
function rosterRows(answers: Record<string, unknown>, chain: string[]) {
  let level: { idx: number[]; row: Record<string, unknown> }[] = [{ idx: [], row: answers }];
  for (const r of chain) {
    const next: typeof level = [];
    for (const { idx, row } of level) {
      const rows = row[r];
      if (Array.isArray(rows))
        rows.forEach((x, i) => {
          if (x && typeof x === 'object')
            next.push({ idx: [...idx, i + 1], row: x as Record<string, unknown> });
        });
    }
    level = next;
  }
  return level;
}

/**
 * The dataset of a questionnaire's interviews: meta columns, then one or more columns per
 * variable in questionnaire order, the same for every mode (so data from all modes merges).
 * Coded columns carry value labels; don't know / refused keep their codes and are declared
 * missing. Rosters are numbered columns (wide) or a table each (long).
 */
export function buildTables(
  compiled: CompiledQuestionnaire,
  interviews: ExportInterview[],
  opts: BuildOptions,
): { main: Table; rosters: Table[] } {
  const lang = opts.language ?? compiled.questionnaire.defaultLanguage;
  const fields = fieldsOf(compiled, lang);
  // Text of "other" and coding results are separate answer keys.
  const top = fields.filter((f) => !f.chain.length);
  const nested = fields.filter((f) => f.chain.length);
  const coded = new Set<string>();
  for (const i of interviews)
    for (const k of Object.keys(i.answers)) if (/_CODE$/.test(k) && !k.includes('[')) coded.add(k);

  const cellsFor = (answers: Record<string, unknown>, f: Field) => f.cells(answers[f.source]);

  const columns: Column[] = [...META];
  for (const f of top) columns.push(...f.columns.map((c) => ({ ...c, variable: true })));
  for (const c of [...coded].sort())
    columns.push({
      name: c,
      label: `${c.replace(/_CODE$/, '')} (codificado)`,
      type: 'numeric',
      measure: 'nominal',
    });

  // Wide rosters: numbered copies of each roster column, as many as the data needs.
  const wide: { f: Field; idx: number[] }[] = [];
  if (opts.rosters === 'wide') {
    const chains = new Map<string, Field[]>();
    for (const f of nested)
      chains.set(f.chain.join('.'), [...(chains.get(f.chain.join('.')) ?? []), f]);
    for (const fs of chains.values()) {
      const seen = new Map<string, number[]>();
      for (const i of interviews)
        for (const r of rosterRows(i.answers, fs[0]!.chain)) seen.set(r.idx.join('_'), r.idx);
      const keys = [...seen.values()].sort((a, b) => {
        for (let k = 0; k < Math.max(a.length, b.length); k++)
          if ((a[k] ?? 0) !== (b[k] ?? 0)) return (a[k] ?? 0) - (b[k] ?? 0);
        return 0;
      });
      // Person by person: every column of row 1, then of row 2…
      for (const idx of keys)
        for (const f of fs) {
          wide.push({ f, idx });
          for (const c of f.columns)
            columns.push({
              ...c,
              name: `${c.name}_${idx.join('_')}`,
              label: `${c.label} [${idx.join('.')}]`,
            });
        }
    }
  }
  if (opts.paradata) columns.push(...PARADATA);

  const rows: Cell[][] = interviews.map((i) => {
    const row: Cell[] = meta(i);
    for (const f of top) row.push(...cellsFor(i.answers, f));
    for (const c of [...coded].sort()) {
      const v = i.answers[c];
      row.push(typeof v === 'number' ? v : null);
    }
    for (const w of wide) {
      const hit = rosterRows(i.answers, w.f.chain).find((r) => r.idx.join('_') === w.idx.join('_'));
      row.push(...(hit ? cellsFor(hit.row, w.f) : w.f.columns.map(() => null)));
    }
    if (opts.paradata)
      row.push(
        i.paradata?.backMoves ?? 0,
        i.paradata?.notes ?? 0,
        i.paradata?.pauses ?? 0,
        i.paradata?.warnings ?? 0,
        i.flags && Object.keys(i.flags).length ? Object.keys(i.flags).sort().join(' ') : null,
      );
    return row;
  });

  const rosters: Table[] = [];
  if (opts.rosters === 'long') {
    const chains = new Map<string, Field[]>();
    for (const f of nested) {
      const k = f.chain.join('.');
      chains.set(k, [...(chains.get(k) ?? []), f]);
    }
    for (const [k, fs] of chains) {
      const chain = fs[0]!.chain;
      const cols: Column[] = [
        { name: 'interview_id', label: 'Interview id', type: 'string' },
        { name: 'case_id', label: 'Case id', type: 'string' },
        ...chain.map((r) => ({ name: `${r}_row`, label: `${r} row`, type: 'numeric' as const })),
        ...fs.flatMap((f) => f.columns),
      ];
      const rrows: Cell[][] = [];
      for (const i of interviews)
        for (const r of rosterRows(i.answers, chain))
          rrows.push([i.id, i.caseId, ...r.idx, ...fs.flatMap((f) => cellsFor(r.row, f))]);
      rosters.push({ name: k.replace(/\./g, '_'), columns: cols, rows: rrows });
    }
  }
  return { main: { name: compiled.questionnaire.id, columns, rows }, rosters };
}
