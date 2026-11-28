import { encodeAll, type Cell, type Column, type Table, type TableEncoder } from './table.js';
import { csvSeparator, readableRow, type ReadableFormat } from './readable.js';

const quote = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Text a spreadsheet would run as a formula (=, +, -, @, tab, carriage return first) is kept as
 * text with a leading apostrophe, so an answer can never act in the analyst's spreadsheet.
 */
export const safeCell = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

const encoder = new TextEncoder();

/**
 * CSV in UTF-8 with a byte-order mark (so spreadsheet programs read accents correctly).
 * With `labels`, coded cells are written as their labels; with `format` too, moments and
 * numbers as the organisation's regional format writes them (see `readableRow`), separated
 * by `;` where that format's decimal mark is a comma (see `csvSeparator`).
 */
export function csvEncoder(
  columns: Column[],
  opts: { labels?: boolean; format?: ReadableFormat } = {},
): TableEncoder {
  const readable = opts.labels && opts.format ? readableRow(columns, opts.format) : null;
  const sep = readable ? csvSeparator(opts.format!.locale) : ',';
  const line = (row: Cell[]) => {
    const shown = readable ? readable(row) : row;
    return row
      .map((cell, i) => {
        if (cell === null || cell === undefined) return '';
        const col = columns[i]!;
        if (opts.labels && typeof cell === 'number' && col.valueLabels?.has(cell))
          return quote(safeCell(col.valueLabels.get(cell)!));
        // A number stays a number (-1,5 is not a formula), however the format writes it.
        return quote(typeof cell === 'string' ? safeCell(String(shown[i])) : String(shown[i]));
      })
      .join(sep);
  };
  return {
    head: () =>
      encoder.encode(`\uFEFF${columns.map((c) => quote(safeCell(c.name))).join(sep)}\r\n`),
    rows: (batch) => encoder.encode(batch.map((r) => `${line(r)}\r\n`).join('')),
    tail: () => new Uint8Array(0),
  };
}

export function writeCsv(
  table: Table,
  opts: { labels?: boolean; format?: ReadableFormat } = {},
): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(
    encodeAll(csvEncoder(table.columns, opts), table.rows),
  );
}
