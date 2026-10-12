import type { Node } from './ast.js';
import type { Scope } from './evaluator.js';
import {
  isAnswered,
  isMissing,
  isSpecial,
  isoDate,
  looseEquals,
  monthsBetween,
  parseIsoDate,
  toNumber,
  truthy,
  type Value,
} from './values.js';

type Eval = (node: Node, scope: Scope) => Value;

/** Static type tags used by the type checker. */
export type TypeTag =
  'number' | 'string' | 'boolean' | 'date' | 'code' | 'array' | 'roster' | 'any';

export interface FunctionDef {
  minArgs: number;
  maxArgs?: number;
  returns: TypeTag;
  /** Arguments that must be a variable reference (not an arbitrary expression). */
  varArgs?: number[];
  /** Argument that must name a roster; the following argument is evaluated per row. */
  rosterArg?: number;
  doc: string;
  impl(args: Node[], scope: Scope, ev: Eval): Value;
}

function flattenNumbers(values: Value[]): number[] {
  const out: number[] = [];
  const visit = (v: Value) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (!isMissing(v)) {
      const n = typeof v === 'boolean' ? null : toNumber(v);
      if (n !== null) out.push(n);
    }
  };
  values.forEach(visit);
  return out;
}

/** Name of the variable an argument refers to (`Q7`, `HH[2].SEX` → `SEX`). */
export function referencedVariable(node: Node): string | null {
  if (node.type === 'var') return node.name;
  if (node.type === 'member') return node.property;
  if (node.type === 'index') return referencedVariable(node.object);
  return null;
}

function rosterName(node: Node): string | null {
  return node.type === 'var' ? node.name : null;
}

type DateUnit = 'days' | 'weeks' | 'months' | 'years' | 'hours' | 'minutes';

export const FUNCTIONS: Record<string, FunctionDef> = {
  answered: {
    minArgs: 1,
    maxArgs: 1,
    returns: 'boolean',
    doc: 'True when the question holds an answer (DK and Refused count as answered).',
    impl: ([a], s, ev) => isAnswered(ev(a!, s)),
  },
  count: {
    minArgs: 2,
    maxArgs: 2,
    returns: 'number',
    doc: 'Number of elements of a multi-choice answer or roster column equal to a code.',
    impl: ([a, b], s, ev) => {
      const v = ev(a!, s);
      const code = ev(b!, s);
      if (isMissing(code)) return 0;
      if (Array.isArray(v)) return v.filter((x) => !isMissing(x) && looseEquals(x, code)).length;
      return !isMissing(v) && looseEquals(v, code) ? 1 : 0;
    },
  },
  sum: {
    minArgs: 1,
    returns: 'number',
    doc: 'Sum of numeric arguments (arrays are flattened); unanswered values are ignored. Null if none.',
    impl: (args, s, ev) => {
      const ns = flattenNumbers(args.map((a) => ev(a, s)));
      return ns.length === 0 ? null : ns.reduce((x, y) => x + y, 0);
    },
  },
  min: {
    minArgs: 1,
    returns: 'number',
    doc: 'Smallest numeric argument; null if none answered.',
    impl: (args, s, ev) => {
      const ns = flattenNumbers(args.map((a) => ev(a, s)));
      return ns.length === 0 ? null : Math.min(...ns);
    },
  },
  max: {
    minArgs: 1,
    returns: 'number',
    doc: 'Largest numeric argument; null if none answered.',
    impl: (args, s, ev) => {
      const ns = flattenNumbers(args.map((a) => ev(a, s)));
      return ns.length === 0 ? null : Math.max(...ns);
    },
  },
  length: {
    minArgs: 1,
    maxArgs: 1,
    returns: 'number',
    doc: 'Length of a text or number of selected codes / roster rows. 0 when unanswered.',
    impl: ([a], s, ev) => {
      const v = ev(a!, s);
      if (typeof v === 'string') return v.length;
      if (Array.isArray(v)) return v.length;
      return 0;
    },
  },
  contains: {
    minArgs: 2,
    maxArgs: 2,
    returns: 'boolean',
    doc: 'True when a multi-choice answer includes the code, or a text includes the substring.',
    impl: ([a, b], s, ev) => {
      const v = ev(a!, s);
      const x = ev(b!, s);
      if (isMissing(v) || isMissing(x)) return false;
      if (Array.isArray(v)) return v.some((e) => looseEquals(e, x));
      if (typeof v === 'string' && typeof x === 'string') return v.includes(x);
      return looseEquals(v, x);
    },
  },
  age: {
    minArgs: 1,
    maxArgs: 2,
    returns: 'number',
    doc: 'Completed years between a date of birth and a reference date (default today).',
    impl: ([a, b], s, ev) => {
      const from = parseIsoDate(ev(a!, s));
      const to = parseIsoDate(b ? ev(b, s) : s.today);
      if (from === null || to === null) return null;
      return Math.trunc(monthsBetween(from, to) / 12);
    },
  },
  datediff: {
    minArgs: 2,
    maxArgs: 3,
    returns: 'number',
    doc: "Difference b − a in whole units: 'days' (default), 'weeks', 'months', 'years', 'hours', 'minutes'.",
    impl: ([a, b, u], s, ev) => {
      const from = parseIsoDate(ev(a!, s));
      const to = parseIsoDate(ev(b!, s));
      const unit = u ? ev(u, s) : 'days';
      if (from === null || to === null || typeof unit !== 'string') return null;
      const ms = to - from;
      switch (unit as DateUnit) {
        case 'days':
          return Math.trunc(ms / 86_400_000);
        case 'weeks':
          return Math.trunc(ms / (7 * 86_400_000));
        case 'hours':
          return Math.trunc(ms / 3_600_000);
        case 'minutes':
          return Math.trunc(ms / 60_000);
        case 'months':
          return monthsBetween(from, to);
        case 'years':
          return Math.trunc(monthsBetween(from, to) / 12);
        default:
          return null;
      }
    },
  },
  today: {
    minArgs: 0,
    maxArgs: 0,
    returns: 'date',
    doc: "Today's date (ISO), fixed for the evaluation so client and server agree.",
    impl: (_args, s) => s.today,
  },
  date: {
    minArgs: 1,
    maxArgs: 1,
    returns: 'date',
    doc: 'Parses an ISO date string; null when invalid.',
    impl: ([a], s, ev) => {
      const ms = parseIsoDate(ev(a!, s));
      return ms === null ? null : isoDate(ms);
    },
  },
  label: {
    minArgs: 1,
    maxArgs: 1,
    returns: 'string',
    varArgs: [0],
    doc: 'Label of the selected code (labels joined with ", " for multi-choice).',
    impl: ([a], s, ev) => {
      const name = referencedVariable(a!);
      const v = ev(a!, s);
      if (!name || !isAnswered(v)) return null;
      if (Array.isArray(v)) {
        const labels = v.map((c) => s.label(name, c) ?? String(c));
        return labels.join(', ');
      }
      return s.label(name, v);
    },
  },
  isDK: {
    minArgs: 1,
    maxArgs: 1,
    returns: 'boolean',
    doc: "True when the answer is Don't know.",
    impl: ([a], s, ev) => {
      const v = ev(a!, s);
      return isSpecial(v) && v.$special === 'DK';
    },
  },
  isRefused: {
    minArgs: 1,
    maxArgs: 1,
    returns: 'boolean',
    doc: 'True when the answer is Refused.',
    impl: ([a], s, ev) => {
      const v = ev(a!, s);
      return isSpecial(v) && v.$special === 'RF';
    },
  },
  rosterCount: {
    minArgs: 1,
    maxArgs: 1,
    returns: 'number',
    rosterArg: 0,
    doc: 'Number of rows in a roster.',
    impl: ([a], s, ev) => {
      const v = ev(a!, s);
      return Array.isArray(v) ? v.length : 0;
    },
  },
  any: {
    minArgs: 2,
    maxArgs: 2,
    returns: 'boolean',
    rosterArg: 0,
    doc: 'True when the condition holds for at least one roster row.',
    impl: ([r, cond], s, ev) => {
      const name = rosterName(r!);
      const rows = ev(r!, s);
      if (!name || !Array.isArray(rows)) return false;
      for (let i = 1; i <= rows.length; i++) {
        const rs = s.rowScope(name, i);
        if (rs && truthy(ev(cond!, rs))) return true;
      }
      return false;
    },
  },
  all: {
    minArgs: 2,
    maxArgs: 2,
    returns: 'boolean',
    rosterArg: 0,
    doc: 'True when the condition holds for every roster row (true for an empty roster).',
    impl: ([r, cond], s, ev) => {
      const name = rosterName(r!);
      const rows = ev(r!, s);
      if (!name || !Array.isArray(rows)) return true;
      for (let i = 1; i <= rows.length; i++) {
        const rs = s.rowScope(name, i);
        if (!rs || !truthy(ev(cond!, rs))) return false;
      }
      return true;
    },
  },
  round: {
    minArgs: 1,
    maxArgs: 2,
    returns: 'number',
    doc: 'Rounds to n decimals (default 0).',
    impl: ([a, d], s, ev) => {
      const n = toNumber(ev(a!, s));
      const places = d ? toNumber(ev(d, s)) : 0;
      if (n === null || places === null) return null;
      const f = 10 ** Math.max(0, Math.min(10, Math.trunc(places)));
      return Math.round(n * f) / f;
    },
  },
  abs: {
    minArgs: 1,
    maxArgs: 1,
    returns: 'number',
    doc: 'Absolute value.',
    impl: ([a], s, ev) => {
      const n = toNumber(ev(a!, s));
      return n === null ? null : Math.abs(n);
    },
  },
};
