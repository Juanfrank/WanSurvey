import type { Namespace } from '../src/ast.js';
import type { Scope } from '../src/evaluator.js';
import type { Value } from '../src/values.js';

/** Minimal Scope over a plain answers object; roster children are read from `rows`. */
export function mapScope(
  vars: Record<string, Value>,
  opts: {
    ns?: Partial<Record<Namespace, Record<string, unknown>>>;
    rosters?: Record<string, string[]>;
    row?: { roster: string; index: number; parent?: Scope };
    labels?: Record<string, Record<string, string>>;
    mode?: string;
    today?: string;
  } = {},
): Scope {
  const rowVars = (roster: string, index: number): Record<string, Value> => {
    const rows = vars[roster];
    return Array.isArray(rows) ? ((rows[index - 1] as Record<string, Value>) ?? {}) : {};
  };
  const self: Scope = {
    get(name) {
      if (opts.row) {
        const children = opts.rosters?.[opts.row.roster] ?? [];
        if (children.includes(name)) return rowVars(opts.row.roster, opts.row.index)[name] ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name] ?? null;
      for (const children of Object.values(opts.rosters ?? {}))
        if (children.includes(name)) return null;
      return undefined;
    },
    namespace: (ns) => opts.ns?.[ns],
    rowIndex: () => opts.row?.index ?? null,
    rowScope: (roster, index) =>
      opts.rosters?.[roster] ? mapScope(vars, { ...opts, row: { roster, index } }) : null,
    label: (name, code) => opts.labels?.[name]?.[String(code)] ?? null,
    mode: opts.mode ?? 'CAPI',
    today: opts.today ?? '2026-10-12',
  };
  return self;
}
