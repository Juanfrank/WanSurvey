import type { Table } from './table.js';

export interface CodebookEntry {
  name: string;
  label: string;
  type: 'numeric' | 'string';
  measure: string;
  values: { code: number; label: string; missing: boolean }[];
}

/** Every column of a dataset with its label, type and coded values (M6). */
export function codebook(table: Table): CodebookEntry[] {
  return table.columns.map((c) => {
    const missing = new Set(c.missing ?? []);
    return {
      name: c.name,
      label: c.label,
      type: c.type,
      measure: c.measure ?? (c.type === 'string' ? 'nominal' : 'scale'),
      values: [...(c.valueLabels ?? [])].map(([code, label]) => ({
        code,
        label,
        missing: missing.has(code),
      })),
    };
  });
}
