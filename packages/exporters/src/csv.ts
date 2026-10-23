import type { Table } from './table.js';

const quote = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Text a spreadsheet would run as a formula (=, +, -, @, tab, carriage return first) is kept as
 * text with a leading apostrophe, so an answer can never act in the analyst's spreadsheet.
 */
export const safeCell = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/**
 * CSV in UTF-8 with a byte-order mark (so spreadsheet programs read accents correctly).
 * With `labels`, coded cells are written as their labels.
 */
export function writeCsv(table: Table, opts: { labels?: boolean } = {}): string {
  const lines = [table.columns.map((c) => quote(safeCell(c.name))).join(',')];
  for (const row of table.rows)
    lines.push(
      row
        .map((cell, i) => {
          if (cell === null || cell === undefined) return '';
          const col = table.columns[i]!;
          if (opts.labels && typeof cell === 'number' && col.valueLabels?.has(cell))
            return quote(safeCell(col.valueLabels.get(cell)!));
          return quote(typeof cell === 'string' ? safeCell(cell) : String(cell));
        })
        .join(','),
    );
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
