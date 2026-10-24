import { questionOptions, type CompiledQuestionnaire } from '@wansurvey/logic';
import type { LocalizedText, Question } from '@wansurvey/schema';
import type { Cell, Column, ColumnSource, Table } from './table.js';

/** One interview as the export reads it. */
export interface ExportInterview {
  id: string;
  caseId: string | null;
  /** The case's code from the sample (its external id), to join the frame. */
  caseCode?: string | null;
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
  /** From the sampling selector (S1): the case's role, stratum, π and base weight 1/π. */
  sampling?: {
    role: string | null;
    stratum: string | null;
    prob: number | null;
    weight: number | null;
  };
}

export interface BuildOptions {
  /** wide: roster answers as numbered columns; long: a table per roster. */
  rosters: 'wide' | 'long';
  paradata: boolean;
  /** Language of labels; the questionnaire's default when left out. */
  language?: string;
  /** Answers marked personal are left out unless this is true (people without `pii.view`). */
  personal?: boolean;
}

type Special = { $special: string };
const isSpecial = (v: unknown): v is Special =>
  !!v && typeof v === 'object' && !Array.isArray(v) && '$special' in v;

/**
 * Plain text of a label: tags stripped, a piped value (it differs per respondent) shown as …,
 * never as written; whitespace collapsed.
 */
function plain(text: LocalizedText | undefined, lang: string, fallback: string): string {
  const t = text?.[lang] ?? (text ? Object.values(text)[0] : undefined) ?? fallback;
  return t
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\{#if [^}]*\}\}|\{\{else\}\}|\{\{\/if\}\}/g, '')
    .replace(/\{\{[^}]*\}\}/g, '…')
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

const answer = (
  variable: string,
  read: Extract<ColumnSource, { kind: 'answer' }>['read'],
  more: Partial<Extract<ColumnSource, { kind: 'answer' }>> = {},
): ColumnSource => ({ kind: 'answer', variable, read, ...more });

function fieldsOf(compiled: CompiledQuestionnaire, lang: string, personal: boolean): Field[] {
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
        columns: [
          {
            name,
            label: name,
            type: numeric ? 'numeric' : 'string',
            source: { kind: 'answer', variable: name, read: 'computed', numeric },
          },
        ],
        cells: (v) => [
          v === null || v === undefined ? null : numeric ? Number(v) : JSON.stringify(v),
        ],
      });
      continue;
    }
    const def = node.def as Question;
    if (def.personal && !personal) continue;
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
                  source: answer(name, 'code'),
                }
              : { name, label, type: 'string', source: answer(name, 'text') },
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
            source: answer(name, 'dummy', { code: String(o.code) }),
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
            source: answer(name, 'rank', { position: i + 1 }),
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
            source: answer(name, 'grid', { row: String(r.code) }),
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
      case 'scale': {
        // A Likert or NPS scale is a few labelled points: ordinal, with a label per point, so
        // it gets a frequency table and crosstabs. A slider stays a number.
        const sc = def.scale;
        const step = sc?.step ?? 1;
        const points =
          sc && sc.style !== 'slider' && Number.isInteger(step) && (sc.max - sc.min) / step < 11
            ? Array.from(
                { length: Math.floor((sc.max - sc.min) / step) + 1 },
                (_, k) => sc.min + k * step,
              )
            : null;
        if (sc && points) {
          const labels = new Map<number, string>();
          for (const p of points) {
            const end = p === sc.min ? sc.minLabel : p === sc.max ? sc.maxLabel : undefined;
            labels.set(p, end ? `${p} – ${plain(end, lang, '')}` : String(p));
          }
          for (const [c, l] of specialLabels) labels.set(c, l);
          fields.push({
            source: name,
            chain,
            columns: [
              {
                name,
                label,
                type: 'numeric',
                valueLabels: labels,
                missing,
                measure: 'ordinal',
                source: answer(name, 'code'),
              },
            ],
            cells: (v) => [code(v)],
          });
          break;
        }
      }
      // falls through
      case 'numeric':
        fields.push({
          source: name,
          chain,
          columns: [
            {
              name,
              label,
              type: 'numeric',
              valueLabels: specialLabels,
              missing,
              measure: 'scale',
              source: answer(name, 'code'),
            },
          ],
          cells: (v) => [code(v)],
        });
        break;
      default:
        fields.push({
          source: name,
          chain,
          columns: [
            def.type === 'text'
              ? { name, label, type: 'string', open: true, missing, source: answer(name, 'text') }
              : { name, label, type: 'string', source: answer(name, 'text') },
          ],
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
        columns: [
          {
            name: `${name}_OTHER`,
            label: `${label} (otro)`,
            type: 'string',
            open: true,
            source: answer(`${name}_OTHER`, 'other'),
          },
        ],
        cells: (v) => [typeof v === 'string' && v.trim() ? v : null],
      });
    }
  }
  return fields;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

const META: Column[] = [
  {
    name: 'interview_id',
    source: { kind: 'meta', field: 'interview_id' },
    label: 'Interview id',
    type: 'string',
  },
  { name: 'case_id', source: { kind: 'meta', field: 'case_id' }, label: 'Case id', type: 'string' },
  {
    name: 'case_code',
    source: { kind: 'meta', field: 'case_code' },
    label: 'Case code (from the sample)',
    type: 'string',
  },
  { name: 'mode', source: { kind: 'meta', field: 'mode' }, label: 'Mode', type: 'string' },
  { name: 'status', source: { kind: 'meta', field: 'status' }, label: 'Status', type: 'string' },
  {
    name: 'disposition',
    source: { kind: 'meta', field: 'disposition' },
    label: 'Disposition',
    type: 'string',
  },
  {
    name: 'interviewer',
    source: { kind: 'meta', field: 'interviewer' },
    label: 'Interviewer',
    type: 'string',
  },
  {
    name: 'started_at',
    source: { kind: 'meta', field: 'started_at' },
    label: 'Start (UTC)',
    type: 'string',
  },
  {
    name: 'submitted_at',
    source: { kind: 'meta', field: 'submitted_at' },
    label: 'Submitted (UTC)',
    type: 'string',
  },
  {
    name: 'active_seconds',
    source: { kind: 'meta', field: 'active_seconds' },
    label: 'Active time (seconds)',
    type: 'numeric',
    measure: 'scale',
  },
  {
    name: 'version',
    source: { kind: 'meta', field: 'version' },
    label: 'Questionnaire version',
    type: 'numeric',
    measure: 'ordinal',
  },
  {
    name: 'language',
    source: { kind: 'meta', field: 'language' },
    label: 'Language',
    type: 'string',
  },
  {
    name: 'selection_role',
    source: { kind: 'meta', field: 'selection_role' },
    label: 'Selection role',
    type: 'string',
  },
  { name: 'stratum', source: { kind: 'meta', field: 'stratum' }, label: 'Stratum', type: 'string' },
  {
    name: 'inclusion_prob',
    source: { kind: 'meta', field: 'inclusion_prob' },
    label: 'Probability of inclusion',
    type: 'numeric',
    measure: 'scale',
  },
  {
    name: 'base_weight',
    source: { kind: 'meta', field: 'base_weight' },
    label: 'Base weight (1/π)',
    type: 'numeric',
    measure: 'scale',
  },
];
const PARADATA: Column[] = [
  {
    name: 'back_moves',
    source: { kind: 'paradata', field: 'back_moves' },
    label: 'Back moves',
    type: 'numeric',
    measure: 'scale',
  },
  {
    name: 'notes',
    source: { kind: 'paradata', field: 'notes' },
    label: 'Notes added',
    type: 'numeric',
    measure: 'scale',
  },
  {
    name: 'pauses',
    source: { kind: 'paradata', field: 'pauses' },
    label: 'Pauses',
    type: 'numeric',
    measure: 'scale',
  },
  {
    name: 'warnings_confirmed',
    source: { kind: 'paradata', field: 'warnings_confirmed' },
    label: 'Soft warnings confirmed',
    type: 'numeric',
    measure: 'scale',
  },
  {
    name: 'flags',
    source: { kind: 'paradata', field: 'flags' },
    label: 'Review flags',
    type: 'string',
  },
];

function meta(i: ExportInterview): Cell[] {
  return [
    i.id,
    i.caseId,
    i.caseCode ?? null,
    i.mode,
    i.status,
    i.disposition,
    i.interviewer,
    iso(i.startedAt),
    iso(i.submittedAt),
    Math.round(i.activeMs / 1000),
    i.version,
    i.language,
    i.sampling?.role ?? null,
    i.sampling?.stratum ?? null,
    i.sampling?.prob ?? null,
    i.sampling?.weight ?? null,
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

/** One table's columns, before any row (the layout the rows follow). */
export interface TableLayout {
  name: string;
  columns: Column[];
}

/** Compares 1-based roster row indexes, outermost first. */
const byIndex = (a: number[], b: number[]) => {
  for (let k = 0; k < Math.max(a.length, b.length); k++)
    if ((a[k] ?? 0) !== (b[k] ?? 0)) return (a[k] ?? 0) - (b[k] ?? 0);
  return 0;
};

/**
 * The dataset of a questionnaire's interviews, built one interview at a time so an export of
 * any size needs memory for one page of interviews only: `observe` every interview first (the
 * columns depend on the data: coded "other" texts, and in wide rosters how many rows there
 * are), then `layout`, then the rows of each interview with `mainRow` and `rosterRows`.
 *
 * Meta columns, then one or more columns per variable in questionnaire order, the same for
 * every mode (so data from all modes merges). Coded columns carry value labels; don't know /
 * refused keep their codes and are declared missing. Rosters are numbered columns (wide) or a
 * table each (long).
 */
export class TableBuilder {
  private readonly top: Field[];
  /** Roster fields by chain ("HH" or "HH.KIDS"), in questionnaire order. */
  private readonly chains = new Map<string, Field[]>();
  private readonly coded = new Set<string>();
  /** Wide rosters: the rows seen, by chain. */
  private readonly seen = new Map<string, Map<string, number[]>>();
  private frozen?: {
    coded: string[];
    wide: { f: Field; idx: number[]; key: string }[];
    main: TableLayout;
    rosters: TableLayout[];
  };

  constructor(
    private readonly compiled: CompiledQuestionnaire,
    private readonly opts: BuildOptions,
  ) {
    const lang = opts.language ?? compiled.questionnaire.defaultLanguage;
    const fields = fieldsOf(compiled, lang, opts.personal ?? true);
    this.top = fields.filter((f) => !f.chain.length);
    for (const f of fields.filter((x) => x.chain.length)) {
      const k = f.chain.join('.');
      this.chains.set(k, [...(this.chains.get(k) ?? []), f]);
    }
  }

  /** Notes what an interview adds to the columns. */
  observe(i: ExportInterview) {
    if (this.frozen) throw new Error('observe() after layout()');
    // Text of "other" and coding results are separate answer keys.
    for (const k of Object.keys(i.answers))
      if (/_CODE$/.test(k) && !k.includes('[')) this.coded.add(k);
    if (this.opts.rosters === 'wide')
      for (const [k, fs] of this.chains) {
        let rows = this.seen.get(k);
        if (!rows) this.seen.set(k, (rows = new Map()));
        for (const r of rosterRows(i.answers, fs[0]!.chain)) rows.set(r.idx.join('_'), r.idx);
      }
  }

  /** The tables' columns, fixed from here on. */
  layout(): { main: TableLayout; rosters: TableLayout[] } {
    if (this.frozen) return { main: this.frozen.main, rosters: this.frozen.rosters };
    const coded = [...this.coded].sort();
    const columns: Column[] = [...META];
    for (const f of this.top) columns.push(...f.columns.map((c) => ({ ...c, variable: true })));
    for (const c of coded)
      columns.push({
        name: c,
        label: `${c.replace(/_CODE$/, '')} (codificado)`,
        type: 'numeric',
        measure: 'nominal',
        source: answer(c, 'coded'),
      });
    // Wide rosters: numbered copies of each roster column, as many as the data needs.
    const wide: { f: Field; idx: number[]; key: string }[] = [];
    if (this.opts.rosters === 'wide')
      for (const [k, fs] of this.chains) {
        const keys = [...(this.seen.get(k)?.values() ?? [])].sort(byIndex);
        // Person by person: every column of row 1, then of row 2…
        for (const idx of keys)
          for (const f of fs) {
            wide.push({ f, idx, key: idx.join('_') });
            for (const c of f.columns)
              columns.push({
                ...c,
                name: `${c.name}_${idx.join('_')}`,
                label: `${c.label} [${idx.join('.')}]`,
                ...(c.source?.kind === 'answer' ? { source: { ...c.source, path: idx } } : {}),
              });
          }
      }
    if (this.opts.paradata) columns.push(...PARADATA);
    const rosters: TableLayout[] = [];
    if (this.opts.rosters === 'long')
      for (const [k, fs] of this.chains)
        rosters.push({
          name: k.replace(/\./g, '_'),
          columns: [
            META[0]!,
            META[1]!,
            ...fs[0]!.chain.map((r, level) => ({
              name: `${r}_row`,
              label: `${r} row`,
              type: 'numeric' as const,
              source: { kind: 'roster_row' as const, level: level + 1 },
            })),
            ...fs.flatMap((f) => f.columns),
          ],
        });
    this.frozen = {
      coded,
      wide,
      main: { name: this.compiled.questionnaire.id, columns },
      rosters,
    };
    return { main: this.frozen.main, rosters };
  }

  /** An interview's row of the main table. */
  mainRow(i: ExportInterview): Cell[] {
    const { coded, wide } = this.frozen ?? this.fix();
    const row: Cell[] = meta(i);
    for (const f of this.top) row.push(...f.cells(i.answers[f.source]));
    for (const c of coded) {
      const v = i.answers[c];
      row.push(typeof v === 'number' ? v : null);
    }
    if (wide.length) {
      const rows = new Map<string, Map<string, Record<string, unknown>>>();
      for (const w of wide) {
        const chain = w.f.chain.join('.');
        let byIdx = rows.get(chain);
        if (!byIdx) {
          byIdx = new Map(rosterRows(i.answers, w.f.chain).map((r) => [r.idx.join('_'), r.row]));
          rows.set(chain, byIdx);
        }
        const hit = byIdx.get(w.key);
        row.push(...(hit ? w.f.cells(hit[w.f.source]) : w.f.columns.map(() => null)));
      }
    }
    if (this.opts.paradata)
      row.push(
        i.paradata?.backMoves ?? 0,
        i.paradata?.notes ?? 0,
        i.paradata?.pauses ?? 0,
        i.paradata?.warnings ?? 0,
        i.flags && Object.keys(i.flags).length ? Object.keys(i.flags).sort().join(' ') : null,
      );
    return row;
  }

  /** An interview's rows of a long roster table (by its index in `layout().rosters`). */
  rosterRows(i: ExportInterview, table: number): Cell[][] {
    if (!this.frozen) this.fix();
    const fs = [...this.chains.values()][table]!;
    return rosterRows(i.answers, fs[0]!.chain).map((r) => [
      i.id,
      i.caseId,
      ...r.idx,
      ...fs.flatMap((f) => f.cells(r.row[f.source])),
    ]);
  }

  private fix() {
    this.layout();
    return this.frozen!;
  }
}

/** The whole dataset in memory (topline, summaries, small exports and tests). */
export function buildTables(
  compiled: CompiledQuestionnaire,
  interviews: ExportInterview[],
  opts: BuildOptions,
): { main: Table; rosters: Table[] } {
  const b = new TableBuilder(compiled, opts);
  for (const i of interviews) b.observe(i);
  const { main, rosters } = b.layout();
  return {
    main: { ...main, rows: interviews.map((i) => b.mainRow(i)) },
    rosters: rosters.map((t, k) => ({ ...t, rows: interviews.flatMap((i) => b.rosterRows(i, k)) })),
  };
}
