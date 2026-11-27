import type { Cell, Column, Table } from './table.js';

/** One row of a frequency table. */
export interface Frequency {
  code: number;
  label: string;
  count: number;
  /** Share of the valid answers (don't know / refused left out); null for those codes. */
  percent: number | null;
  missing: boolean;
}

/** Fields every topline item has: the variable, its label, and whether a formula computes it. */
interface ItemHead {
  name: string;
  label: string;
  /** A computed variable (no question text: its label is its name unless the designer gave one). */
  computed?: boolean;
}

export type ToplineItem = ItemHead &
  (
    | {
        kind: 'single';
        base: number;
        rows: Frequency[];
        /** For an ordinal scale: the mean of the valid answers. */
        mean?: number | null;
      }
    | {
        kind: 'multi';
        /** Respondents who answered the question. */
        base: number;
        rows: { code: string; label: string; count: number; percent: number | null }[];
      }
    | {
        kind: 'text';
        /** Respondents who wrote something. */
        n: number;
        /** The latest answers, newest first (at most `TEXT_EXAMPLES`). */
        latest: string[];
        /**
         * The most frequent answers once spelling is evened out (case, accents, spaces), most
         * frequent first (at most `TEXT_EXAMPLES`), each in the form written most often.
         */
        groups: { text: string; count: number }[];
        /** Different answers after evening out. */
        distinct: number;
      }
    | {
        kind: 'numeric';
        /** Valid answers. */
        n: number;
        /** Answers coded don't know / refused (left out of the statistics). */
        specials: number;
        /** Interviews with no value (not asked, skipped). */
        blank: number;
        mean: number | null;
        median: number | null;
        min: number | null;
        max: number | null;
      }
  );

/** How many open answers the topline shows per question. */
export const TEXT_EXAMPLES = 10;

const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);

function stats(values: number[]) {
  if (!values.length) return { n: 0, mean: null, median: null, min: null, max: null };
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    median: s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2,
    min: s[0]!,
    max: s[s.length - 1]!,
  };
}

const isComputed = (c: Column) => c.source?.kind === 'answer' && c.source.read === 'computed';
const head = (c: Column): ItemHead => ({
  name: c.name,
  label: c.label,
  ...(isComputed(c) ? { computed: true } : {}),
});

/** Spelling evened out: accents, case and repeated spaces do not make answers different. */
const textKey = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s.,;:!?¡¿"'()-]+/g, ' ')
    .trim();

/** Open answers grouped by their evened-out spelling, the most frequent first. */
export function textGroups(written: string[]): {
  groups: { text: string; count: number }[];
  distinct: number;
} {
  const byKey = new Map<string, { count: number; forms: Map<string, number> }>();
  for (const w of written) {
    const text = w.trim().replace(/\s+/g, ' ');
    const key = textKey(text) || text;
    const g = byKey.get(key) ?? { count: 0, forms: new Map<string, number>() };
    g.count++;
    g.forms.set(text, (g.forms.get(text) ?? 0) + 1);
    byKey.set(key, g);
  }
  const groups = [...byKey.values()]
    .map((g) => ({
      // The form written most often (the first of those on a tie).
      text: [...g.forms].reduce((a, b) => (b[1] > a[1] ? b : a))[0],
      count: g.count,
    }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  return { groups: groups.slice(0, TEXT_EXAMPLES), distinct: groups.length };
}

const isCoded = (c: Column) =>
  c.type === 'numeric' && !!c.valueLabels?.size && c.measure !== 'scale';

function frequencies(table: Table, i: number): { base: number; rows: Frequency[] } {
  const col = table.columns[i]!;
  const missing = new Set(col.missing ?? []);
  const counts = new Map<number, number>();
  for (const row of table.rows) {
    const v = row[i];
    if (typeof v === 'number') counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const base = [...counts].reduce((a, [code, n]) => a + (missing.has(code) ? 0 : n), 0);
  const codes = [...col.valueLabels!.keys()];
  for (const c of counts.keys()) if (!col.valueLabels!.has(c)) codes.push(c);
  const rows = codes
    .filter((c) => !missing.has(c) || counts.get(c))
    .map((code) => {
      const count = counts.get(code) ?? 0;
      const m = missing.has(code);
      return {
        code,
        label: col.valueLabels!.get(code) ?? String(code),
        count,
        percent: m ? null : pct(count, base),
        missing: m,
      };
    });
  // Valid codes first, then don't know / refused.
  rows.sort((a, b) => Number(a.missing) - Number(b.missing));
  return { base, rows };
}

/**
 * The topline of a dataset (S1): a frequency table for each coded question (with the mean for
 * a scale), the share choosing each option of a multiple choice, summary statistics for
 * numbers, and the latest open answers. Meta and paradata columns are left out.
 */
export function topline(table: Table): ToplineItem[] {
  const items: ToplineItem[] = [];
  const done = new Set<string>();
  table.columns.forEach((col, i) => {
    if (col.variable && col.open) {
      const special = new Set((col.missing ?? []).map(String));
      const written = table.rows
        .map((r) => r[i])
        .filter((v): v is string => typeof v === 'string' && !!v.trim() && !special.has(v));
      items.push({
        kind: 'text',
        ...head(col),
        n: written.length,
        latest: written.slice(-TEXT_EXAMPLES).reverse(),
        ...textGroups(written),
      });
      return;
    }
    if (!col.variable || col.type !== 'numeric') return;
    if (col.group) {
      if (done.has(col.group.name)) return;
      done.add(col.group.name);
      const idx = table.columns
        .map((c, j) => (c.group?.name === col.group!.name ? j : -1))
        .filter((j) => j >= 0);
      const missing = new Set(col.missing ?? []);
      let base = 0;
      const counts = idx.map(() => 0);
      for (const row of table.rows) {
        const v = row[idx[0]!];
        if (typeof v !== 'number' || missing.has(v)) continue;
        base++;
        idx.forEach((j, k) => {
          if (row[j] === 1) counts[k]!++;
        });
      }
      items.push({
        kind: 'multi',
        name: col.group.name,
        label: col.group.label,
        ...(isComputed(col) ? { computed: true } : {}),
        base,
        rows: idx.map((j, k) => {
          const c = table.columns[j]!;
          return {
            code: c.name.slice(col.group!.name.length + 1),
            label: c.label.slice(col.group!.label.length + 2),
            count: counts[k]!,
            percent: pct(counts[k]!, base),
          };
        }),
      });
      return;
    }
    if (isCoded(col)) {
      const f = frequencies(table, i);
      const mean =
        col.measure === 'ordinal' && f.base
          ? f.rows.reduce((a, r) => a + (r.missing ? 0 : r.code * r.count), 0) / f.base
          : undefined;
      items.push({
        kind: 'single',
        ...head(col),
        ...f,
        ...(mean === undefined ? {} : { mean }),
      });
      return;
    }
    const missing = new Set(col.missing ?? []);
    const cells = table.rows.map((r) => r[i]);
    const values = cells.filter((v): v is number => typeof v === 'number' && !missing.has(v));
    const specials = cells.filter((v) => typeof v === 'number' && missing.has(v)).length;
    items.push({
      kind: 'numeric',
      ...head(col),
      ...stats(values),
      specials,
      blank: cells.length - values.length - specials,
    });
  });
  return items;
}

/** Variables a crosstab can use: coded, one column each. */
export function crosstabVariables(table: Table): { name: string; label: string }[] {
  return table.columns
    .filter((c) => c.variable && !c.group && isCoded(c))
    .map((c) => ({ name: c.name, label: c.label }));
}

export interface Crosstab {
  row: { name: string; label: string; categories: { code: number; label: string }[] };
  col: { name: string; label: string; categories: { code: number; label: string }[] };
  /** counts[r][c] */
  counts: number[][];
  rowTotals: number[];
  colTotals: number[];
  total: number;
  /** Column percentages: counts[r][c] / colTotals[c]. */
  colPercents: (number | null)[][];
  /** Row percentages: counts[r][c] / rowTotals[r]. */
  rowPercents: (number | null)[][];
  /** Percentages of the table total. */
  totalPercents: (number | null)[][];
  /**
   * Pearson's chi-square test of independence, over the rows and columns with answers; null
   * when there are fewer than two of either. `sparse`: more than a fifth of the expected counts
   * are under 5, so the p-value is only a rough guide.
   */
  chi2: { statistic: number; df: number; p: number; sparse: boolean } | null;
}

/** Bases under this many interviews are flagged: their percentages move a lot with one answer. */
export const LOW_BASE = 30;

/** ln Γ(x) (Lanczos). */
function lnGamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const k of c) ser += k / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** The upper regularised incomplete gamma Q(a, x) (series below a + 1, continued fraction above). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 500; n++) {
      del *= x / ++ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** The probability of a chi-square of `df` degrees of freedom being at least `x`. */
export const chiSquareP = (x: number, df: number) =>
  Math.min(1, Math.max(0, gammaQ(df / 2, x / 2)));

function chiSquare(counts: number[][], rowTotals: number[], colTotals: number[], total: number) {
  const rs = rowTotals.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
  const cs = colTotals.map((n, j) => (n > 0 ? j : -1)).filter((j) => j >= 0);
  if (rs.length < 2 || cs.length < 2) return null;
  let statistic = 0;
  let small = 0;
  for (const i of rs)
    for (const j of cs) {
      const e = (rowTotals[i]! * colTotals[j]!) / total;
      if (e < 5) small++;
      statistic += (counts[i]![j]! - e) ** 2 / e;
    }
  const df = (rs.length - 1) * (cs.length - 1);
  return {
    statistic,
    df,
    p: chiSquareP(statistic, df),
    sparse: small > 0.2 * rs.length * cs.length,
  };
}

/** Two coded questions against each other, valid answers only (S2). */
export function crosstab(table: Table, rowName: string, colName: string): Crosstab | null {
  const ri = table.columns.findIndex((c) => c.name === rowName);
  const ci = table.columns.findIndex((c) => c.name === colName);
  if (ri < 0 || ci < 0) return null;
  const rc = table.columns[ri]!;
  const cc = table.columns[ci]!;
  if (!isCoded(rc) || !isCoded(cc)) return null;
  const cats = (c: Column) => {
    const missing = new Set(c.missing ?? []);
    return [...c.valueLabels!]
      .filter(([code]) => !missing.has(code))
      .map(([code, label]) => ({ code, label }));
  };
  const rows = cats(rc);
  const cols = cats(cc);
  const counts = rows.map(() => cols.map(() => 0));
  const rpos = new Map(rows.map((r, k) => [r.code, k]));
  const cpos = new Map(cols.map((c, k) => [c.code, k]));
  for (const row of table.rows) {
    const a = rpos.get(row[ri] as number);
    const b = cpos.get(row[ci] as number);
    if (a !== undefined && b !== undefined) counts[a]![b]!++;
  }
  const rowTotals = counts.map((r) => r.reduce((x, y) => x + y, 0));
  const colTotals = cols.map((_, b) => counts.reduce((x, r) => x + r[b]!, 0));
  const total = rowTotals.reduce((x, y) => x + y, 0);
  return {
    row: { name: rc.name, label: rc.label, categories: rows },
    col: { name: cc.name, label: cc.label, categories: cols },
    counts,
    rowTotals,
    colTotals,
    total,
    colPercents: counts.map((r) => r.map((n, b) => pct(n, colTotals[b]!))),
    rowPercents: counts.map((r, a) => r.map((n) => pct(n, rowTotals[a]!))),
    totalPercents: counts.map((r) => r.map((n) => pct(n, total))),
    chi2: chiSquare(counts, rowTotals, colTotals, total),
  };
}

/** Keeps the rows whose `name` column holds one of `codes`. */
export function filterRows(table: Table, name: string, codes: Cell[]): Table {
  const i = table.columns.findIndex((c) => c.name === name);
  if (i < 0) return table;
  const keep = new Set(codes.map(String));
  return { ...table, rows: table.rows.filter((r) => r[i] !== null && keep.has(String(r[i]))) };
}
