import type { Table } from './table.js';

const quote = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * CSV in UTF-8 with a byte-order mark (so spreadsheet programs read accents correctly).
 * With `labels`, coded cells are written as their labels.
 */
export function writeCsv(table: Table, opts: { labels?: boolean } = {}): string {
  const lines = [table.columns.map((c) => quote(c.name)).join(',')];
  for (const row of table.rows)
    lines.push(
      row
        .map((cell, i) => {
          if (cell === null || cell === undefined) return '';
          const col = table.columns[i]!;
          if (opts.labels && typeof cell === 'number' && col.valueLabels?.has(cell))
            return quote(col.valueLabels.get(cell)!);
          return quote(String(cell));
        })
        .join(','),
    );
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
