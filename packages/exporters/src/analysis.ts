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

export type ToplineItem =
  | { kind: 'single'; name: string; label: string; base: number; rows: Frequency[] }
  | {
      kind: 'multi';
      name: string;
      label: string;
      /** Respondents who answered the question. */
      base: number;
      rows: { code: string; label: string; count: number; percent: number | null }[];
    }
  | {
      kind: 'numeric';
      name: string;
      label: string;
      n: number;
      mean: number | null;
      median: number | null;
      min: number | null;
      max: number | null;
    };

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
 * The topline of a dataset (S1): a frequency table for each coded question, the share choosing
 * each option of a multiple choice, and summary statistics for numbers. Meta, text and
 * paradata columns are left out.
 */
export function topline(table: Table): ToplineItem[] {
  const items: ToplineItem[] = [];
  const done = new Set<string>();
  table.columns.forEach((col, i) => {
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
      items.push({ kind: 'single', name: col.name, label: col.label, ...f });
      return;
    }
    const missing = new Set(col.missing ?? []);
    const values = table.rows
      .map((r) => r[i])
      .filter((v): v is number => typeof v === 'number' && !missing.has(v));
    items.push({ kind: 'numeric', name: col.name, label: col.label, ...stats(values) });
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
  return {
    row: { name: rc.name, label: rc.label, categories: rows },
    col: { name: cc.name, label: cc.label, categories: cols },
    counts,
    rowTotals,
    colTotals,
    total: rowTotals.reduce((x, y) => x + y, 0),
    colPercents: counts.map((r) => r.map((n, b) => pct(n, colTotals[b]!))),
  };
}

/** Keeps the rows whose `name` column holds one of `codes`. */
export function filterRows(table: Table, name: string, codes: Cell[]): Table {
  const i = table.columns.findIndex((c) => c.name === name);
  if (i < 0) return table;
  const keep = new Set(codes.map(String));
  return { ...table, rows: table.rows.filter((r) => r[i] !== null && keep.has(String(r[i]))) };
}
