import { encodeAll, type Cell, type Column, type Table, type TableEncoder } from './table.js';

const quote = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Text a spreadsheet would run as a formula (=, +, -, @, tab, carriage return first) is kept as
 * text with a leading apostrophe, so an answer can never act in the analyst's spreadsheet.
 */
export const safeCell = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

const encoder = new TextEncoder();

/**
 * CSV in UTF-8 with a byte-order mark (so spreadsheet programs read accents correctly).
 * With `labels`, coded cells are written as their labels.
 */
export function csvEncoder(columns: Column[], opts: { labels?: boolean } = {}): TableEncoder {
  const line = (row: Cell[]) =>
    row
      .map((cell, i) => {
        if (cell === null || cell === undefined) return '';
        const col = columns[i]!;
        if (opts.labels && typeof cell === 'number' && col.valueLabels?.has(cell))
          return quote(safeCell(col.valueLabels.get(cell)!));
        return quote(typeof cell === 'string' ? safeCell(cell) : String(cell));
      })
      .join(',');
  return {
    head: () =>
      encoder.encode(`\uFEFF${columns.map((c) => quote(safeCell(c.name))).join(',')}\r\n`),
    rows: (batch) => encoder.encode(batch.map((r) => `${line(r)}\r\n`).join('')),
    tail: () => new Uint8Array(0),
  };
}

export function writeCsv(table: Table, opts: { labels?: boolean } = {}): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(
    encodeAll(csvEncoder(table.columns, opts), table.rows),
  );
}
